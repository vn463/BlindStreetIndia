// src/utils/ModelCache.ts
// Loads GLB models from app bundle.
// Patches THREE.ImageLoader to skip texture decoding (no Image API in React Native).
// Models load with geometry + base colors — no textures but fully visible.

import { Asset } from 'expo-asset';
import * as FileSystem from 'expo-file-system';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader';
import { MODEL_ASSETS } from './modelAssets';

// ── Patch THREE.ImageLoader once at module load ────────────────────────────────
// React Native / Hermes has no `new Image()` — Three.js texture loading crashes.
// We replace it with a no-op that returns a 1×1 white pixel so parse() always
// resolves, then we strip the broken texture references after loading.
let patched = false;
function patchImageLoader() {
  if (patched) return;
  patched = true;
  const proto = (THREE.ImageLoader as any).prototype;
  proto.load = function (
    _url: string,
    onLoad?: (img: any) => void,
    _onProgress?: any,
    _onError?: any
  ) {
    // Return a minimal image-like object so Three.js doesn't crash
    const fakeImage = { width: 1, height: 1, data: new Uint8Array([255, 255, 255, 255]) };
    setTimeout(() => onLoad && onLoad(fakeImage), 0);
    return fakeImage;
  };
}

// ── Strip broken texture maps after load ───────────────────────────────────────
// After patching, textures are 1×1 white. We remove them entirely so materials
// show their base diffuse color instead of a washed-out white overlay.
function stripTextures(scene: THREE.Group) {
  scene.traverse((child: any) => {
    if (!child.isMesh) return;
    const mats = Array.isArray(child.material) ? child.material : [child.material];
    mats.forEach((mat: any) => {
      if (!mat) return;
      // Keep the diffuse color, remove all texture maps
      ['map', 'normalMap', 'roughnessMap', 'metalnessMap',
       'aoMap', 'emissiveMap', 'alphaMap', 'bumpMap'].forEach(key => {
        if (mat[key]) { mat[key].dispose(); mat[key] = null; }
      });
      mat.needsUpdate = true;
    });
    child.castShadow = true;
    child.receiveShadow = true;
  });
}

// ── Base64 decoder (fast, no atob) ────────────────────────────────────────────
function base64ToBuffer(base64: string): ArrayBuffer {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const lookup = new Uint8Array(256);
  for (let i = 0; i < chars.length; i++) lookup[chars.charCodeAt(i)] = i;
  const clean = base64.replace(/[\s=]+$/, '');
  const out = new Uint8Array(Math.floor(clean.length * 3 / 4));
  let idx = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const a = lookup[clean.charCodeAt(i)];
    const b = lookup[clean.charCodeAt(i + 1)];
    const c = lookup[clean.charCodeAt(i + 2)] ?? 0;
    const d = lookup[clean.charCodeAt(i + 3)] ?? 0;
    if (idx < out.length) out[idx++] = (a << 2) | (b >> 4);
    if (idx < out.length) out[idx++] = ((b & 15) << 4) | (c >> 2);
    if (idx < out.length) out[idx++] = ((c & 3) << 6) | d;
  }
  return out.buffer;
}

// ── Load single GLB from bundle ───────────────────────────────────────────────
async function loadGLB(modelKey: string): Promise<THREE.Group> {
  patchImageLoader(); // ensure patched before any parse

  const assetModule = MODEL_ASSETS[modelKey];
  if (!assetModule) throw new Error(`No asset: ${modelKey}`);

  const [asset] = await Asset.loadAsync(assetModule);
  const uri = asset.localUri ?? asset.uri;
  if (!uri) throw new Error(`No URI: ${modelKey}`);

  const base64 = await FileSystem.readAsStringAsync(uri, {
    encoding: FileSystem.EncodingType.Base64,
  });
  if (!base64 || base64.length === 0) throw new Error(`Empty: ${modelKey}`);

  const buffer = base64ToBuffer(base64);
  console.log(`[ModelCache] Parsing ${modelKey}: ${buffer.byteLength} bytes`);

  const loader = new GLTFLoader();
  const gltf = await new Promise<any>((resolve, reject) => {
    loader.parse(buffer, '', resolve, (err) =>
      reject(err instanceof Error ? err : new Error(String(err)))
    );
  });

  stripTextures(gltf.scene);
  console.log(`[ModelCache] Ready: ${modelKey}`);
  return gltf.scene;
}

// ── Public API ────────────────────────────────────────────────────────────────
const loadedModels = new Map<string, THREE.Group | null>();

export async function loadModel(modelKey: string): Promise<THREE.Group | null> {
  if (loadedModels.has(modelKey)) {
    const cached = loadedModels.get(modelKey)!;
    return cached ? cached.clone(true) : null;
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
