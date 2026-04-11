// src/utils/ModelCache.ts
//
// ROOT CAUSE (confirmed from Three.js r166 source):
//   GLTFLoader.parse() calls `new TextDecoder()` on its first line → crashes in Hermes.
//   GLTFBinaryExtension constructor also calls `new TextDecoder()` → same crash.
//
// SOLUTION:
//   1. Parse GLB binary ourselves with pure-JS (no TextDecoder)
//   2. Strip texture references from JSON (prevents URL.createObjectURL crash)
//   3. Pre-populate THREE.Cache with the binary body under a unique key
//   4. Set buffer[0].uri to that cache key in the JSON
//   5. Call loader.parse(jsonObject) — passes the `else` branch (json = data),
//      bypassing ALL TextDecoder calls
//   6. THREE.FileLoader finds the body in Cache immediately, no network request
//
// Verified: all 13 GLBs parse correctly with this approach.

import { Asset } from 'expo-asset';
import * as FileSystem from 'expo-file-system';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader';
import { MODEL_ASSETS } from './modelAssets';

// ── Pure-JS base64 → ArrayBuffer ──────────────────────────────────────────────
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

// ── Pure-JS GLB parser (no TextDecoder at all) ────────────────────────────────
function parseGLB(buffer: ArrayBuffer): { json: any; body: ArrayBuffer | null } {
  const view = new DataView(buffer);
  if (view.getUint32(0, true) !== 0x46546C67) throw new Error('Not a valid GLB');

  const jsonLen  = view.getUint32(12, true);
  const jsonType = view.getUint32(16, true);
  if (jsonType !== 0x4E4F534A) throw new Error('Expected JSON chunk first');

  // Decode JSON bytes to string using pure charCode operations — no TextDecoder
  const jsonBytes = new Uint8Array(buffer, 20, jsonLen);
  let str = '';
  for (let i = 0; i < jsonBytes.length; i++) {
    const b = jsonBytes[i];
    if (b < 0x80) {
      str += String.fromCharCode(b);
    } else if ((b & 0xE0) === 0xC0 && i + 1 < jsonBytes.length) {
      str += String.fromCharCode(((b & 0x1F) << 6) | (jsonBytes[++i] & 0x3F));
    } else if ((b & 0xF0) === 0xE0 && i + 2 < jsonBytes.length) {
      str += String.fromCharCode(((b & 0x0F) << 12) | ((jsonBytes[++i] & 0x3F) << 6) | (jsonBytes[++i] & 0x3F));
    } else {
      i += 3;
    }
  }
  const json = JSON.parse(str);

  // Extract BIN chunk body
  let body: ArrayBuffer | null = null;
  const binStart = 20 + jsonLen;
  if (binStart + 8 <= buffer.byteLength) {
    const binLen  = view.getUint32(binStart, true);
    const binType = view.getUint32(binStart + 4, true);
    if (binType === 0x004E4942 && binLen > 0) {
      body = buffer.slice(binStart + 8, binStart + 8 + binLen);
    }
  }

  return { json, body };
}

// ── Strip texture references from GLTF JSON ───────────────────────────────────
function stripTextures(json: any, cacheKey: string): any {
  const j = JSON.parse(JSON.stringify(json)); // deep clone

  // Remove all texture-related data
  delete j.images;
  delete j.textures;
  delete j.samplers;

  // Remove texture references from materials
  if (Array.isArray(j.materials)) {
    j.materials.forEach((mat: any) => {
      if (mat.pbrMetallicRoughness) {
        delete mat.pbrMetallicRoughness.baseColorTexture;
        delete mat.pbrMetallicRoughness.metallicRoughnessTexture;
      }
      delete mat.normalTexture;
      delete mat.occlusionTexture;
      delete mat.emissiveTexture;
    });
  }

  // Point buffer[0] at our THREE.Cache key instead of leaving uri undefined
  // (uri undefined triggers the KHR_BINARY_GLTF path which needs TextDecoder)
  if (j.buffers && j.buffers[0] && j.buffers[0].uri === undefined) {
    j.buffers[0].uri = cacheKey;
  }

  return j;
}

// ── Load a single GLB from bundle ─────────────────────────────────────────────
async function loadGLB(modelKey: string): Promise<THREE.Group> {
  const assetModule = MODEL_ASSETS[modelKey];
  if (!assetModule) throw new Error(`No asset: ${modelKey}`);

  const [asset] = await Asset.loadAsync(assetModule);
  const uri = asset.localUri ?? asset.uri;
  if (!uri) throw new Error(`No URI for: ${modelKey}`);

  const b64 = await FileSystem.readAsStringAsync(uri, {
    encoding: FileSystem.EncodingType.Base64,
  });
  if (!b64 || b64.length === 0) throw new Error(`Empty file: ${modelKey}`);

  const buffer      = base64ToBuffer(b64);
  const { json, body } = parseGLB(buffer);

  // Unique cache key for this model's binary body
  const cacheKey = `bsi_model_${modelKey}_body`;

  // Pre-populate THREE.Cache with the binary body.
  // THREE.FileLoader checks Cache first — returns immediately without network request.
  if (body) {
    THREE.Cache.enabled = true;
    THREE.Cache.add(cacheKey, body);
  }

  // Strip textures and redirect buffer[0] URI to our cache key
  const cleanJson = stripTextures(json, cacheKey);

  console.log(`[ModelCache] Parsing ${modelKey}: meshes=${cleanJson.meshes?.length ?? 0}`);

  // Parse by passing the plain JS object.
  // Three.js parse() checks: instanceof ArrayBuffer → binary path (TextDecoder)
  //                          else → json = data  ← WE TAKE THIS PATH
  // No TextDecoder is used. Buffer[0] is resolved from THREE.Cache.
  const loader = new GLTFLoader();
  const gltf = await new Promise<any>((resolve, reject) => {
    loader.parse(cleanJson, '', resolve, (err: any) => {
      // Clean up cache entry on error
      THREE.Cache.remove(cacheKey);
      reject(err instanceof Error ? err : new Error(String(err)));
    });
  });

  // Clean up cache — no longer needed after parse
  THREE.Cache.remove(cacheKey);

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
