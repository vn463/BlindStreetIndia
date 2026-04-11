// src/utils/ModelCache.ts
//
// CONFIRMED ROOT CAUSE (from Three.js r166 source line 323):
//   GLTFLoader.parse() does `const textDecoder = new TextDecoder()` as its FIRST LINE,
//   before any data-type checks. Passing an ArrayBuffer OR a plain object — doesn't matter.
//   TextDecoder is undefined in Hermes → ReferenceError → onError called → null returned.
//   Every previous attempt failed for this reason.
//
// COMPLETE SOLUTION:
//   1. Polyfill global.TextDecoder with pure-JS UTF-8 implementation
//   2. Strip images/textures/samplers from GLB JSON (prevents URL.createObjectURL crash)
//   3. Pre-populate THREE.Cache with binary body, set buffer[0].uri = cache key
//   4. Call loader.parse(cleanBuffer) normally — now works end-to-end

import { Asset } from 'expo-asset';
import * as FileSystem from 'expo-file-system';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader';
import { MODEL_ASSETS } from './modelAssets';

// ── Step 1: Polyfill TextDecoder for Hermes ────────────────────────────────────
// Must run before any import that uses Three.js GLTFLoader.
// The expo source code comment says: "TextEncoder is in Hermes" — but NOT TextDecoder.
function installPolyfills() {
  const g = global as any;
  if (g.TextDecoder) return; // already available

  g.TextDecoder = class TextDecoder {
    encoding: string;
    constructor(label = 'utf-8') { this.encoding = label; }

    decode(input?: ArrayBuffer | ArrayBufferView): string {
      let bytes: Uint8Array;
      if (!input) return '';
      if (input instanceof ArrayBuffer) {
        bytes = new Uint8Array(input);
      } else if (ArrayBuffer.isView(input)) {
        bytes = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
      } else {
        return '';
      }
      let str = '';
      for (let i = 0; i < bytes.length; i++) {
        const b = bytes[i];
        if (b < 0x80) {
          str += String.fromCharCode(b);
        } else if ((b & 0xE0) === 0xC0 && i + 1 < bytes.length) {
          str += String.fromCharCode(((b & 0x1F) << 6) | (bytes[++i] & 0x3F));
        } else if ((b & 0xF0) === 0xE0 && i + 2 < bytes.length) {
          str += String.fromCharCode(
            ((b & 0x0F) << 12) | ((bytes[++i] & 0x3F) << 6) | (bytes[++i] & 0x3F)
          );
        } else if ((b & 0xF8) === 0xF0 && i + 3 < bytes.length) {
          const cp = ((b & 0x07) << 18) | ((bytes[++i] & 0x3F) << 12) |
                     ((bytes[++i] & 0x3F) << 6) | (bytes[++i] & 0x3F);
          if (cp <= 0xFFFF) {
            str += String.fromCharCode(cp);
          } else {
            const r = cp - 0x10000;
            str += String.fromCharCode(0xD800 + (r >> 10), 0xDC00 + (r & 0x3FF));
          }
        }
      }
      return str;
    }
  };
}

// ── Step 2: Base64 → ArrayBuffer ──────────────────────────────────────────────
function base64ToBuffer(b64: string): ArrayBuffer {
  const clean = b64.replace(/[^A-Za-z0-9+/]/g, '');
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const lut = new Uint8Array(256);
  for (let i = 0; i < chars.length; i++) lut[chars.charCodeAt(i)] = i;
  const out = new Uint8Array(Math.floor(clean.length * 3 / 4));
  let n = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const a = lut[clean.charCodeAt(i)];
    const b = lut[clean.charCodeAt(i + 1)];
    const c = lut[clean.charCodeAt(i + 2)] ?? 0;
    const d = lut[clean.charCodeAt(i + 3)] ?? 0;
    if (n < out.length) out[n++] = (a << 2) | (b >> 4);
    if (n < out.length) out[n++] = ((b & 15) << 4) | (c >> 2);
    if (n < out.length) out[n++] = ((c & 3) << 6) | d;
  }
  return out.buffer;
}

// ── Step 3: Strip textures + inject cache key into GLB binary ─────────────────
// Returns a new GLB where:
//   - images/textures/samplers removed from JSON (prevents URL.createObjectURL)
//   - buffer[0].uri set to cacheKey (so THREE.FileLoader reads from THREE.Cache)
function processGLB(buffer: ArrayBuffer, cacheKey: string): ArrayBuffer {
  const view = new DataView(buffer);
  if (view.getUint32(0, true) !== 0x46546C67) throw new Error('Not a valid GLB');

  const version  = view.getUint32(4, true);
  const jsonLen  = view.getUint32(12, true);
  const jsonType = view.getUint32(16, true);
  if (jsonType !== 0x4E4F534A) throw new Error('Expected JSON chunk');

  // Decode JSON — TextDecoder polyfill is now installed so we can use it here
  const td = new (global as any).TextDecoder();
  const jsonStr = td.decode(new Uint8Array(buffer, 20, jsonLen));
  const json = JSON.parse(jsonStr);

  // Strip all texture-related data
  delete json.images;
  delete json.textures;
  delete json.samplers;
  if (Array.isArray(json.materials)) {
    json.materials.forEach((mat: any) => {
      if (mat.pbrMetallicRoughness) {
        delete mat.pbrMetallicRoughness.baseColorTexture;
        delete mat.pbrMetallicRoughness.metallicRoughnessTexture;
      }
      delete mat.normalTexture;
      delete mat.occlusionTexture;
      delete mat.emissiveTexture;
    });
  }

  // Redirect buffer[0] to THREE.Cache key
  // (GLB buffer[0] normally has no URI — Three.js reads it from KHR_BINARY_GLTF.body.
  //  Setting a URI makes Three.js use FileLoader instead, which checks THREE.Cache.)
  if (json.buffers && json.buffers[0]) {
    json.buffers[0].uri = cacheKey;
  }

  // Re-encode JSON (TextEncoder IS in Hermes natively)
  const te = new TextEncoder();
  const newJsonBytes = te.encode(JSON.stringify(json));
  const padded = Math.ceil(newJsonBytes.length / 4) * 4;
  const newJsonPadded = new Uint8Array(padded).fill(0x20);
  newJsonPadded.set(newJsonBytes);

  // Extract BIN chunk
  const binStart = 20 + jsonLen;
  let binChunk: Uint8Array | null = null;
  if (binStart + 8 <= buffer.byteLength) {
    const binLen  = view.getUint32(binStart, true);
    const binType = view.getUint32(binStart + 4, true);
    if (binType === 0x004E4942 && binLen > 0) {
      binChunk = new Uint8Array(buffer, binStart, 8 + binLen);
    }
  }

  // Rebuild GLB
  const totalLen = 12 + 8 + padded + (binChunk ? binChunk.length : 0);
  const out = new ArrayBuffer(totalLen);
  const outView = new DataView(out);
  const outBytes = new Uint8Array(out);

  outView.setUint32(0, 0x46546C67, true);
  outView.setUint32(4, version, true);
  outView.setUint32(8, totalLen, true);
  outView.setUint32(12, padded, true);
  outView.setUint32(16, 0x4E4F534A, true);
  outBytes.set(newJsonPadded, 20);
  if (binChunk) outBytes.set(binChunk, 20 + padded);

  return out;
}

// ── Step 4: Load single model ──────────────────────────────────────────────────
async function loadGLB(modelKey: string): Promise<THREE.Group> {
  installPolyfills(); // must be before any GLTFLoader usage

  const assetModule = MODEL_ASSETS[modelKey];
  if (!assetModule) throw new Error(`No asset: ${modelKey}`);

  const [asset] = await Asset.loadAsync(assetModule);
  const uri = asset.localUri ?? asset.uri;
  if (!uri) throw new Error(`No URI: ${modelKey}`);

  const b64 = await FileSystem.readAsStringAsync(uri, {
    encoding: FileSystem.EncodingType.Base64,
  });
  if (!b64 || b64.length === 0) throw new Error(`Empty file: ${modelKey}`);

  const rawBuffer = base64ToBuffer(b64);

  // Extract binary body for THREE.Cache
  const rawView = new DataView(rawBuffer);
  const jsonLen = rawView.getUint32(12, true);
  const binStart = 20 + jsonLen;
  let body: ArrayBuffer | null = null;
  if (binStart + 8 <= rawBuffer.byteLength) {
    const binLen  = rawView.getUint32(binStart, true);
    const binType = rawView.getUint32(binStart + 4, true);
    if (binType === 0x004E4942 && binLen > 0) {
      body = rawBuffer.slice(binStart + 8, binStart + 8 + binLen);
    }
  }

  // Pre-populate THREE.Cache with the binary body
  const cacheKey = `bsi_${modelKey}`;
  THREE.Cache.enabled = true;
  if (body) THREE.Cache.add(cacheKey, body);

  // Process GLB: strip textures, redirect buffer URI to cache key
  const cleanBuffer = processGLB(rawBuffer, cacheKey);

  console.log(`[ModelCache] Parsing ${modelKey}: ${cleanBuffer.byteLength} bytes`);

  try {
    const loader = new GLTFLoader();
    const gltf = await new Promise<any>((resolve, reject) => {
      loader.parse(cleanBuffer, '', resolve, (err: any) => {
        reject(err instanceof Error ? err : new Error(String(err)));
      });
    });

    gltf.scene.traverse((child: any) => {
      if (child.isMesh) { child.castShadow = true; child.receiveShadow = true; }
    });

    console.log(`[ModelCache] Ready: ${modelKey}`);
    return gltf.scene;
  } finally {
    THREE.Cache.remove(cacheKey);
  }
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
    console.warn(`[ModelCache] FAILED ${modelKey}: ${err?.message}`);
    loadedModels.set(modelKey, null);
    return null;
  }
}

export async function preloadAllModels(
  onProgress?: (loaded: number, total: number) => void
): Promise<void> {
  installPolyfills(); // ensure polyfilled before any model loading
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
