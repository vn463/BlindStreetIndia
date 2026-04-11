// src/utils/ModelCache.ts
//
// ROOT CAUSE of GLB texture failure in React Native:
// Three.js GLTFLoader calls `URL.createObjectURL(blob)` for embedded textures.
// `self.URL` is undefined in React Native / Hermes — crashes before ImageLoader.
// Patching ImageLoader does NOT fix this — the crash is upstream of it.
//
// SOLUTION: Strip all image/texture/sampler data from the GLB JSON chunk
// BEFORE passing to loader.parse(). Three.js never attempts texture loading.
// Geometry, materials (with base colors), animations all load correctly.

import { Asset } from 'expo-asset';
import * as FileSystem from 'expo-file-system';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader';
import { MODEL_ASSETS } from './modelAssets';

// ── Strip textures from GLB binary ─────────────────────────────────────────────
// GLB structure: [Header 12B][JSON chunk][BIN chunk]
// We rewrite the JSON chunk with images/textures/samplers removed.
// Geometry buffers in the BIN chunk are untouched.
function stripGLBTextures(buffer: ArrayBuffer): ArrayBuffer {
  const view = new DataView(buffer);

  // Validate GLB magic: 0x46546C67 = 'glTF'
  if (view.getUint32(0, true) !== 0x46546C67) return buffer;

  const version    = view.getUint32(4, true);
  const jsonLen    = view.getUint32(12, true);
  const jsonType   = view.getUint32(16, true); // must be 0x4E4F534A = JSON

  if (jsonType !== 0x4E4F534A) return buffer; // not standard GLB

  // Decode JSON chunk
  const jsonBytes = new Uint8Array(buffer, 20, jsonLen);
  const jsonStr   = new TextDecoder('utf-8').decode(jsonBytes);
  const json      = JSON.parse(jsonStr);

  // Remove all texture-related sections
  delete json.images;
  delete json.textures;
  delete json.samplers;

  // Remove texture references from all materials
  if (Array.isArray(json.materials)) {
    json.materials = json.materials.map((mat: any) => {
      const m = { ...mat };
      if (m.pbrMetallicRoughness) {
        const pbr = { ...m.pbrMetallicRoughness };
        delete pbr.baseColorTexture;
        delete pbr.metallicRoughnessTexture;
        m.pbrMetallicRoughness = pbr;
      }
      delete m.normalTexture;
      delete m.occlusionTexture;
      delete m.emissiveTexture;
      return m;
    });
  }

  // Re-encode JSON, padded to 4-byte boundary with spaces (GLB spec)
  const newJsonStr   = JSON.stringify(json);
  const encoded      = new TextEncoder().encode(newJsonStr);
  const padded       = Math.ceil(encoded.length / 4) * 4;
  const newJsonBytes = new Uint8Array(padded).fill(0x20); // pad with 0x20 = space
  newJsonBytes.set(encoded);

  // Find BIN chunk (immediately after JSON chunk)
  const binOffset = 20 + jsonLen;
  let binChunkBytes: Uint8Array | null = null;
  if (binOffset + 8 <= buffer.byteLength) {
    const binLen  = view.getUint32(binOffset, true);
    const binType = view.getUint32(binOffset + 4, true); // 0x004E4942 = BIN
    if (binType === 0x004E4942 && binLen > 0) {
      binChunkBytes = new Uint8Array(buffer, binOffset, 8 + binLen);
    }
  }

  // Rebuild GLB
  const totalLen = 12 + 8 + padded + (binChunkBytes ? binChunkBytes.length : 0);
  const out      = new ArrayBuffer(totalLen);
  const outView  = new DataView(out);
  const outBytes = new Uint8Array(out);

  // Header
  outView.setUint32(0, 0x46546C67, true); // magic 'glTF'
  outView.setUint32(4, version, true);
  outView.setUint32(8, totalLen, true);

  // JSON chunk
  outView.setUint32(12, padded, true);
  outView.setUint32(16, 0x4E4F534A, true); // type JSON
  outBytes.set(newJsonBytes, 20);

  // BIN chunk (geometry data — keep intact)
  if (binChunkBytes) {
    outBytes.set(binChunkBytes, 20 + padded);
  }

  return out;
}

// ── Base64 → ArrayBuffer ───────────────────────────────────────────────────────
function base64ToBuffer(b64: string): ArrayBuffer {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const lut = new Uint8Array(256);
  for (let i = 0; i < chars.length; i++) lut[chars.charCodeAt(i)] = i;
  const clean = b64.replace(/[\s=]+$/, '');
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

// ── Load single model ──────────────────────────────────────────────────────────
async function loadGLB(modelKey: string): Promise<THREE.Group> {
  const assetModule = MODEL_ASSETS[modelKey];
  if (!assetModule) throw new Error(`No asset: ${modelKey}`);

  // Resolve bundled asset to device filesystem URI
  const [asset] = await Asset.loadAsync(assetModule);
  const uri = asset.localUri ?? asset.uri;
  if (!uri) throw new Error(`No URI: ${modelKey}`);

  // Read as base64 — works for any bundled asset URI
  const b64 = await FileSystem.readAsStringAsync(uri, {
    encoding: FileSystem.EncodingType.Base64,
  });
  if (!b64 || b64.length === 0) throw new Error(`Empty file: ${modelKey}`);

  // Decode → strip textures → parse
  const rawBuffer     = base64ToBuffer(b64);
  const cleanBuffer   = stripGLBTextures(rawBuffer);

  console.log(`[ModelCache] Parsing ${modelKey}: ${cleanBuffer.byteLength} bytes`);

  const loader = new GLTFLoader();
  const gltf = await new Promise<any>((resolve, reject) => {
    loader.parse(cleanBuffer, '', resolve, (err) =>
      reject(err instanceof Error ? err : new Error(String(err)))
    );
  });

  // Enable shadows
  gltf.scene.traverse((child: any) => {
    if (child.isMesh) {
      child.castShadow    = true;
      child.receiveShadow = true;
    }
  });

  console.log(`[ModelCache] Ready: ${modelKey}`);
  return gltf.scene;
}

// ── Public API ─────────────────────────────────────────────────────────────────
const loadedModels = new Map<string, THREE.Group | null>();

export async function loadModel(modelKey: string): Promise<THREE.Group | null> {
  if (loadedModels.has(modelKey)) {
    const c = loadedModels.get(modelKey)!;
    return c ? c.clone(true) : null;
  }
  try {
    const scene = await loadGLB(modelKey);
    loadedModels.set(modelKey, scene);
    return scene.clone(true);
  } catch (err: any) {
    console.warn(`[ModelCache] Failed ${modelKey}: ${err?.message}`);
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
