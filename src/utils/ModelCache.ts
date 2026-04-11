// src/utils/ModelCache.ts
//
// ROOT CAUSE CONFIRMED: Three.js calls URL.createObjectURL() for embedded textures.
// self.URL is undefined in Hermes → crash. Previous fix used TextDecoder/TextEncoder
// to strip texture data from GLB JSON — but TextDecoder is also NOT in Hermes.
//
// THIS FIX: Decode/encode GLB JSON using pure Uint8Array byte operations (no TextDecoder,
// no TextEncoder, no atob, no browser APIs of any kind).

import { Asset } from 'expo-asset';
import * as FileSystem from 'expo-file-system';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader';
import { MODEL_ASSETS } from './modelAssets';

// ── Pure-JS UTF-8 decoder (no TextDecoder) ─────────────────────────────────────
function decodeUTF8(bytes: Uint8Array): string {
  let str = '';
  let i = 0;
  while (i < bytes.length) {
    const b = bytes[i];
    if (b < 0x80) {
      str += String.fromCharCode(b); i++;
    } else if ((b & 0xE0) === 0xC0) {
      str += String.fromCharCode(((b & 0x1F) << 6) | (bytes[i+1] & 0x3F)); i += 2;
    } else if ((b & 0xF0) === 0xE0) {
      str += String.fromCharCode(((b & 0x0F) << 12) | ((bytes[i+1] & 0x3F) << 6) | (bytes[i+2] & 0x3F)); i += 3;
    } else {
      str += String.fromCharCode(((b & 0x07) << 18) | ((bytes[i+1] & 0x3F) << 12) | ((bytes[i+2] & 0x3F) << 6) | (bytes[i+3] & 0x3F)); i += 4;
    }
  }
  return str;
}

// ── Pure-JS UTF-8 encoder (no TextEncoder) ─────────────────────────────────────
function encodeUTF8(str: string): Uint8Array {
  const bytes: number[] = [];
  for (let i = 0; i < str.length; i++) {
    const cp = str.charCodeAt(i);
    if (cp < 0x80) {
      bytes.push(cp);
    } else if (cp < 0x800) {
      bytes.push(0xC0 | (cp >> 6), 0x80 | (cp & 0x3F));
    } else if (cp < 0x10000) {
      bytes.push(0xE0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3F), 0x80 | (cp & 0x3F));
    } else {
      bytes.push(0xF0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3F), 0x80 | ((cp >> 6) & 0x3F), 0x80 | (cp & 0x3F));
    }
  }
  return new Uint8Array(bytes);
}

// ── Strip textures from GLB binary ─────────────────────────────────────────────
// Rewrites the GLB JSON chunk to remove images/textures/samplers.
// Geometry (BIN chunk) is preserved exactly. No browser APIs used.
function stripGLBTextures(buffer: ArrayBuffer): ArrayBuffer {
  const view = new DataView(buffer);

  // Validate GLB magic 'glTF' = 0x46546C67
  if (view.getUint32(0, true) !== 0x46546C67) {
    console.warn('[GLB] Not a valid GLB file');
    return buffer;
  }

  const version  = view.getUint32(4, true);
  const jsonLen  = view.getUint32(12, true);
  const jsonType = view.getUint32(16, true); // 0x4E4F534A = JSON

  if (jsonType !== 0x4E4F534A) {
    console.warn('[GLB] Unexpected JSON chunk type');
    return buffer;
  }

  // Decode JSON chunk using pure-JS UTF-8 (no TextDecoder)
  const jsonBytes = new Uint8Array(buffer, 20, jsonLen);
  const jsonStr   = decodeUTF8(jsonBytes);
  const json      = JSON.parse(jsonStr);

  // Remove all texture-related sections
  delete json.images;
  delete json.textures;
  delete json.samplers;

  // Remove texture references from materials
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

  // Re-encode JSON using pure-JS UTF-8 (no TextEncoder)
  const newJsonStr   = JSON.stringify(json);
  const encoded      = encodeUTF8(newJsonStr);
  const padded       = Math.ceil(encoded.length / 4) * 4;
  const newJsonBytes = new Uint8Array(padded).fill(0x20); // pad with spaces per GLB spec
  newJsonBytes.set(encoded);

  // Find BIN chunk after JSON chunk
  const binOffset = 20 + jsonLen;
  let binChunk: Uint8Array | null = null;
  if (binOffset + 8 <= buffer.byteLength) {
    const binLen  = view.getUint32(binOffset, true);
    const binType = view.getUint32(binOffset + 4, true); // 0x004E4942 = BIN
    if (binType === 0x004E4942 && binLen > 0) {
      binChunk = new Uint8Array(buffer, binOffset, 8 + binLen);
    }
  }

  // Rebuild GLB with cleaned JSON + original BIN
  const totalLen = 12 + 8 + padded + (binChunk ? binChunk.length : 0);
  const out      = new ArrayBuffer(totalLen);
  const outView  = new DataView(out);
  const outBytes = new Uint8Array(out);

  // Header
  outView.setUint32(0, 0x46546C67, true); // 'glTF'
  outView.setUint32(4, version, true);
  outView.setUint32(8, totalLen, true);

  // JSON chunk
  outView.setUint32(12, padded, true);
  outView.setUint32(16, 0x4E4F534A, true); // JSON type
  outBytes.set(newJsonBytes, 20);

  // BIN chunk (geometry — unchanged)
  if (binChunk) {
    outBytes.set(binChunk, 20 + padded);
  }

  return out;
}

// ── Base64 → ArrayBuffer (no atob — strips whitespace safely) ─────────────────
function base64ToBuffer(b64: string): ArrayBuffer {
  // Strip ALL non-base64 characters (including any embedded newlines)
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

// ── Load single model from bundle ──────────────────────────────────────────────
async function loadGLB(modelKey: string): Promise<THREE.Group> {
  const assetModule = MODEL_ASSETS[modelKey];
  if (!assetModule) throw new Error(`No asset: ${modelKey}`);

  const [asset] = await Asset.loadAsync(assetModule);
  const uri = asset.localUri ?? asset.uri;
  if (!uri) throw new Error(`No URI: ${modelKey}`);

  const b64 = await FileSystem.readAsStringAsync(uri, {
    encoding: FileSystem.EncodingType.Base64,
  });
  if (!b64 || b64.length === 0) throw new Error(`Empty: ${modelKey}`);

  const rawBuffer   = base64ToBuffer(b64);
  const cleanBuffer = stripGLBTextures(rawBuffer); // remove textures before parse

  console.log(`[ModelCache] Parsing ${modelKey}: ${cleanBuffer.byteLength} bytes`);

  const loader = new GLTFLoader();
  const gltf = await new Promise<any>((resolve, reject) => {
    loader.parse(cleanBuffer, '', resolve, (err) =>
      reject(err instanceof Error ? err : new Error(String(err)))
    );
  });

  gltf.scene.traverse((child: any) => {
    if (child.isMesh) { child.castShadow = true; child.receiveShadow = true; }
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
