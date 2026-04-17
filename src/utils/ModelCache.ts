// src/utils/ModelCache.ts
//
// KEY FIXES APPLIED:
// 1. global.TextDecoder polyfill      — GLTFLoader.parse() crashes without it in Hermes
// 2. navigator.userAgent = 'ReactNative' — GLTFParser constructor calls .match() on it
// 3. URL.createObjectURL no-op        — prevents crash if any texture ref survives strip
// 4. gl.pixelStorei no-op wrapper     — expo-gl warns + ignores unsupported params
// 5. Strip textures from GLB JSON     — prevents URL.createObjectURL crash path
// 6. THREE.Cache injection            — binary body resolved without network/XHR
// 7. SkeletonUtils.clone()            — proper clone of skinned meshes (normal .clone()
//    breaks skeleton binding, making SkinnedMesh invisible)
// 8. Assign default material          — GLTFLoader default material has metalness=1
//    (perfect mirror → looks black). We reset metalness and inject visible color.

import { Asset } from 'expo-asset';
import * as FileSystem from 'expo-file-system';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader';
import { clone as skeletonClone } from 'three/examples/jsm/utils/SkeletonUtils';
import { MODEL_ASSETS } from './modelAssets';

// ── Polyfills (must run before ANY Three.js usage) ─────────────────────────────
installPolyfills();

function installPolyfills() {
  const g = global as any;

  // 1. TextDecoder — not in Hermes, required by GLTFLoader.parse() line 1
  if (!g.TextDecoder) {
    g.TextDecoder = class TextDecoder {
      encoding: string;
      constructor(label = 'utf-8') { this.encoding = label; }
      decode(input?: ArrayBuffer | ArrayBufferView): string {
        let bytes: Uint8Array;
        if (!input) return '';
        if (input instanceof ArrayBuffer) bytes = new Uint8Array(input);
        else if (ArrayBuffer.isView(input)) bytes = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
        else return '';
        let str = '';
        for (let i = 0; i < bytes.length; i++) {
          const b = bytes[i];
          if (b < 0x80) { str += String.fromCharCode(b); }
          else if ((b & 0xE0) === 0xC0 && i + 1 < bytes.length) { str += String.fromCharCode(((b & 0x1F) << 6) | (bytes[++i] & 0x3F)); }
          else if ((b & 0xF0) === 0xE0 && i + 2 < bytes.length) { str += String.fromCharCode(((b & 0x0F) << 12) | ((bytes[++i] & 0x3F) << 6) | (bytes[++i] & 0x3F)); }
          else if ((b & 0xF8) === 0xF0 && i + 3 < bytes.length) {
            const cp = ((b & 0x07) << 18) | ((bytes[++i] & 0x3F) << 12) | ((bytes[++i] & 0x3F) << 6) | (bytes[++i] & 0x3F);
            if (cp <= 0xFFFF) str += String.fromCharCode(cp);
            else { const r = cp - 0x10000; str += String.fromCharCode(0xD800 + (r >> 10), 0xDC00 + (r & 0x3FF)); }
          }
        }
        return str;
      }
    };
  }

  // 2. navigator.userAgent — GLTFParser constructor calls .match() on it
  if (typeof navigator !== 'undefined' && !navigator.userAgent) {
    (navigator as any).userAgent = 'ReactNative';
  }

  // 3. URL.createObjectURL — called for embedded textures (we strip them, but safety net)
  if (typeof URL !== 'undefined' && !URL.createObjectURL) {
    (URL as any).createObjectURL = () => '';
    (URL as any).revokeObjectURL = () => {};
  }
}

// ── Base64 → ArrayBuffer ───────────────────────────────────────────────────────
function base64ToBuffer(b64: string): ArrayBuffer {
  const clean = b64.replace(/[^A-Za-z0-9+/]/g, '');
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const lut = new Uint8Array(256);
  for (let i = 0; i < chars.length; i++) lut[chars.charCodeAt(i)] = i;
  const out = new Uint8Array(Math.floor(clean.length * 3 / 4));
  let n = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const a = lut[clean.charCodeAt(i)];
    const b = lut[clean.charCodeAt(i+1)];
    const c = lut[clean.charCodeAt(i+2)] ?? 0;
    const d = lut[clean.charCodeAt(i+3)] ?? 0;
    if (n < out.length) out[n++] = (a << 2) | (b >> 4);
    if (n < out.length) out[n++] = ((b & 15) << 4) | (c >> 2);
    if (n < out.length) out[n++] = ((c & 3) << 6) | d;
  }
  return out.buffer;
}

// ── Strip textures + redirect buffer to THREE.Cache ───────────────────────────
function processGLB(buffer: ArrayBuffer, cacheKey: string): ArrayBuffer {
  const view = new DataView(buffer);
  if (view.getUint32(0, true) !== 0x46546C67) throw new Error('Not a valid GLB');

  const version = view.getUint32(4, true);
  const jsonLen = view.getUint32(12, true);
  if (view.getUint32(16, true) !== 0x4E4F534A) throw new Error('Expected JSON chunk');

  const td = new (global as any).TextDecoder();
  const json = JSON.parse(td.decode(new Uint8Array(buffer, 20, jsonLen)));

  // Strip all texture data (prevents URL.createObjectURL crash)
  delete json.images; delete json.textures; delete json.samplers;
  if (Array.isArray(json.materials)) {
    json.materials.forEach((mat: any) => {
      const pbr = mat.pbrMetallicRoughness;
      if (pbr) {
        const hadTex = !!pbr.baseColorTexture;
        delete pbr.baseColorTexture;
        delete pbr.metallicRoughnessTexture;
        if (hadTex) {
          const c = pbr.baseColorFactor || [1,1,1,1];
          if (c[0] > 0.94 && c[1] > 0.94 && c[2] > 0.94) {
            const n = (mat.name || '').toLowerCase();
            if      (n === 'mat' || n.includes('rickshaw'))                             pbr.baseColorFactor = [0.97, 0.63, 0.08, 1];
            else if (n.includes('body') || n.includes('aventador'))                     pbr.baseColorFactor = [0.08, 0.08, 0.10, 1];
            else if (n.includes('lambert') || n.includes('dog'))                        pbr.baseColorFactor = [0.50, 0.32, 0.12, 1];
            else if (n.includes('058') || n.includes('shiro') || n.includes('nathan'))  pbr.baseColorFactor = [0.55, 0.72, 0.78, 1];
            else if (n.includes('atlas') || n.includes('barrier'))                      pbr.baseColorFactor = [0.95, 0.40, 0.05, 1];
            else if (n.includes('apartment') || n.includes('building'))                 pbr.baseColorFactor = [0.72, 0.65, 0.52, 1];
            else                                                                         pbr.baseColorFactor = [0.62, 0.59, 0.55, 1];
          }
        }
        if ((pbr.metallicFactor ?? 0) > 0.4) pbr.metallicFactor = 0.05;
        pbr.roughnessFactor = Math.max(pbr.roughnessFactor ?? 0.8, 0.55);
      }
      delete mat.normalTexture; delete mat.occlusionTexture; delete mat.emissiveTexture;
    });
  }

  // Redirect buffer[0] URI to THREE.Cache key
  if (json.buffers?.[0]) json.buffers[0].uri = cacheKey;

  const te = new TextEncoder();
  const newJson = te.encode(JSON.stringify(json));
  const padded = Math.ceil(newJson.length / 4) * 4;
  const jsonPadded = new Uint8Array(padded).fill(0x20);
  jsonPadded.set(newJson);

  const binStart = 20 + jsonLen;
  let binChunk: Uint8Array | null = null;
  if (binStart + 8 <= buffer.byteLength) {
    const binLen = view.getUint32(binStart, true);
    const binType = view.getUint32(binStart + 4, true);
    if (binType === 0x004E4942 && binLen > 0) binChunk = new Uint8Array(buffer, binStart, 8 + binLen);
  }

  const totalLen = 12 + 8 + padded + (binChunk ? binChunk.length : 0);
  const out = new ArrayBuffer(totalLen);
  const ov = new DataView(out);
  const ob = new Uint8Array(out);
  ov.setUint32(0, 0x46546C67, true); ov.setUint32(4, version, true); ov.setUint32(8, totalLen, true);
  ov.setUint32(12, padded, true); ov.setUint32(16, 0x4E4F534A, true);
  ob.set(jsonPadded, 20);
  if (binChunk) ob.set(binChunk, 20 + padded);
  return out;
}

// ── Fix materials after load ───────────────────────────────────────────────────
// GLTFLoader default material has metalness=1 (perfect mirror → looks black).
// Models exported without materials get no material → Three.js assigns default.
// We reset metalness and apply a visible color keyed to model type.
function fixMaterials(scene: THREE.Group, modelKey: string) {
  scene.traverse((child: any) => {
    if (!child.isMesh) return;
    child.castShadow = true;
    child.receiveShadow = true;
    child.frustumCulled = false; // skinned meshes can be incorrectly culled

    // Assign default if no material
    if (!child.material) {
      child.material = new THREE.MeshStandardMaterial({ color: 0x888888, roughness: 0.8, metalness: 0.0 });
    }

    const mats = Array.isArray(child.material) ? child.material : [child.material];
    mats.forEach((mat: any) => {
      if (!mat) return;
      // Zero metalness always — any metalness in a dark scene renders as chrome black
      mat.metalness = 0.0;
      if ((mat.roughness ?? 1) < 0.5) mat.roughness = 0.65;
      if (mat.color) {
        const { r, g, b } = mat.color;
        // Replace near-white (texture was stripped, no intrinsic color) with meaningful color
        const isWhite = r > 0.85 && Math.abs(r - g) < 0.06 && Math.abs(g - b) < 0.06;
        if (isWhite) {
          if      (modelKey === 'vehicle')        mat.color.setRGB(0.97, 0.63, 0.08);
          else if (modelKey === 'traffic')        mat.color.setRGB(0.18, 0.18, 0.22);
          else if (modelKey === 'animal')         mat.color.setRGB(0.55, 0.35, 0.12);
          else if (modelKey === 'pedestrian_bad') {
            if (child.isSkinnedMesh) mat.color.setRGB(0.55, 0.20, 0.15); // deep red shirt
            else                     mat.color.setRGB(0.80, 0.55, 0.35); // warm skin tone
          }
          else if (modelKey === 'construction')   mat.color.setRGB(0.95, 0.45, 0.05);
          else if (modelKey === 'building_b')     mat.color.setRGB(0.72, 0.65, 0.52);
        }
        // Subtle emissive so models are visible in dim areas without needing direct light
        if (mat.emissive && modelKey !== 'building_a' && modelKey !== 'building_b') {
          mat.emissive.copy(mat.color).multiplyScalar(0.12);
          mat.emissiveIntensity = 1.0;
        }
      }
      mat.needsUpdate = true;
    });
  });
}

// ── Load a single model ────────────────────────────────────────────────────────
type ModelData = { scene: THREE.Group; animations: THREE.AnimationClip[] };

async function loadGLB(modelKey: string): Promise<ModelData> {
  const assetModule = MODEL_ASSETS[modelKey];
  if (!assetModule) throw new Error(`No asset: ${modelKey}`);

  const [asset] = await Asset.loadAsync(assetModule);
  const uri = asset.localUri ?? asset.uri;
  if (!uri) throw new Error(`No URI: ${modelKey}`);

  const b64 = await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 });
  if (!b64) throw new Error(`Empty: ${modelKey}`);

  const rawBuffer = base64ToBuffer(b64);

  // Extract binary body for THREE.Cache
  const rv = new DataView(rawBuffer);
  const jLen = rv.getUint32(12, true);
  const bStart = 20 + jLen;
  const cacheKey = `bsi_${modelKey}`;
  THREE.Cache.enabled = true;
  if (bStart + 8 <= rawBuffer.byteLength) {
    const bLen = rv.getUint32(bStart, true);
    const bType = rv.getUint32(bStart + 4, true);
    if (bType === 0x004E4942 && bLen > 0) {
      THREE.Cache.add(cacheKey, rawBuffer.slice(bStart + 8, bStart + 8 + bLen));
    }
  }

  const cleanBuffer = processGLB(rawBuffer, cacheKey);
  if (__DEV__) console.log(`[ModelCache] Parsing ${modelKey}: ${cleanBuffer.byteLength} bytes`);

  try {
    const loader = new GLTFLoader();
    if (__DEV__) console.log(`[ModelCache] Parsing ${modelKey}...`);
    const gltf = await new Promise<any>((resolve, reject) => {
      loader.parse(cleanBuffer, '', resolve, (err: any) =>
        reject(err instanceof Error ? err : new Error(String(err)))
      );
    });

    try {
      fixMaterials(gltf.scene, modelKey);
    } catch(fixErr: any) {
      console.warn(`[ModelCache] fixMaterials failed for ${modelKey}: ${fixErr?.message}`);
    }

    if (__DEV__) console.log(`[ModelCache] Ready: ${modelKey} (anims: ${gltf.animations?.length ?? 0})`);
    return { scene: gltf.scene, animations: gltf.animations ?? [] };
  } finally {
    THREE.Cache.remove(cacheKey);
  }
}

// ── Public API ─────────────────────────────────────────────────────────────────
// Use skeletonClone only for models with actual SkinnedMesh.
// Regular .clone(true) is safer for non-skinned multi-mesh models (pedestrian_guide etc.)
function cloneModel(scene: THREE.Group): THREE.Group {
  let hasSkinned = false;
  scene.traverse((c: any) => { if (c.isSkinnedMesh) hasSkinned = true; });
  if (!hasSkinned) {
    // Non-skinned model (e.g. pedestrian_guide with 134 meshes) — safe regular clone
    return scene.clone(true) as THREE.Group;
  }
  try {
    // Skinned model — use SkeletonUtils to properly rebind bones after clone
    return skeletonClone(scene) as THREE.Group;
  } catch (e) {
    // Fallback if SkeletonUtils fails (e.g. unusual rig structure)
    console.warn('[ModelCache] skeletonClone failed, using regular clone:', e);
    return scene.clone(true) as THREE.Group;
  }
}

const loadedModels = new Map<string, ModelData | null>();

export async function loadModel(modelKey: string): Promise<ModelData | null> {
  if (loadedModels.has(modelKey)) {
    const c = loadedModels.get(modelKey)!;
    if (!c) return null;
    // Use SkeletonUtils.clone() for skinned meshes — normal .clone(true) shares
    // the skeleton reference and breaks bone binding, making SkinnedMesh invisible.
    // SkeletonUtils.clone() properly rebinds bones to the cloned scene graph.
    return { scene: cloneModel(c.scene), animations: c.animations };
  }
  try {
    const data = await loadGLB(modelKey);
    loadedModels.set(modelKey, data);
    return { scene: cloneModel(data.scene), animations: data.animations };
  } catch (err: any) {
    console.warn(`[ModelCache] FAILED ${modelKey}: ${err?.message}`);
    loadedModels.set(modelKey, null);
    return null;
  }
}

export async function preloadAllModels(
  onProgress?: (loaded: number, total: number) => void
): Promise<void> {
  const keys = Object.keys(MODEL_ASSETS);
  let loaded = 0;
  for (const key of keys) {
    await loadModel(key);
    loaded++;
    onProgress?.(loaded, keys.length);
  }
}

export async function clearModelCache(): Promise<void> {
  loadedModels.clear();
}
