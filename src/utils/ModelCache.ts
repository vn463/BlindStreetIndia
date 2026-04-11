// src/utils/ModelCache.ts
// Loads GLB models from app bundle (no network, no redirects, no browser APIs).
// Flow: require() → expo-asset URI → expo-file-system base64 → ArrayBuffer → GLTFLoader.parse()

import { Asset } from 'expo-asset';
import * as FileSystem from 'expo-file-system';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader';
import { MODEL_ASSETS } from './modelAssets';

const loadedModels = new Map<string, THREE.Group | null>();

// Fast base64 → ArrayBuffer (no per-char loop, no atob dependency)
function base64ToBuffer(base64: string): ArrayBuffer {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const lookup = new Uint8Array(256);
  for (let i = 0; i < chars.length; i++) lookup[chars.charCodeAt(i)] = i;

  const clean = base64.replace(/[\s=]+$/, '');
  const padding = base64.length - clean.length;
  const outputLen = (clean.length * 3) / 4 - padding;
  const out = new Uint8Array(Math.floor(outputLen));
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

async function loadGLB(modelKey: string): Promise<THREE.Group> {
  const assetModule = MODEL_ASSETS[modelKey];
  if (!assetModule) throw new Error(`No asset for key: ${modelKey}`);

  // Resolve bundled asset to local filesystem URI
  const [asset] = await Asset.loadAsync(assetModule);
  const uri = asset.localUri ?? asset.uri;
  if (!uri) throw new Error(`No URI for asset: ${modelKey}`);

  console.log(`[ModelCache] Loading ${modelKey} from ${uri}`);

  // Read file as base64 from local filesystem (always works for bundled assets)
  const base64 = await FileSystem.readAsStringAsync(uri, {
    encoding: FileSystem.EncodingType.Base64,
  });
  if (!base64 || base64.length === 0) throw new Error(`Empty file: ${modelKey}`);

  // Decode to ArrayBuffer and parse
  const buffer = base64ToBuffer(base64);
  console.log(`[ModelCache] ${modelKey}: ${buffer.byteLength} bytes`);

  const loader = new GLTFLoader();
  const gltf = await new Promise<any>((resolve, reject) => {
    loader.parse(buffer, '', resolve, (err) =>
      reject(err instanceof Error ? err : new Error(String(err)))
    );
  });

  gltf.scene.traverse((child: any) => {
    if (child.isMesh) { child.castShadow = true; child.receiveShadow = true; }
  });

  return gltf.scene;
}

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
