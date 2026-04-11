// src/utils/firebase.ts
// Models hosted on GitHub Releases — no Firebase needed.
// Repo: https://github.com/vn463/bsi-models

const GITHUB_BASE = "https://github.com/vn463/bsi-models/releases/download/v1";

export const MODEL_MANIFEST: Record<string, string> = {
  vehicle:         `${GITHUB_BASE}/vehicle_auto_rickshaw.glb`,
  traffic:         `${GITHUB_BASE}/vehicle_car.glb`,
  animal:          `${GITHUB_BASE}/street_dog.glb`,
  pedestrian_bad:  `${GITHUB_BASE}/pedestrian.glb`,
  pedestrian_good: `${GITHUB_BASE}/pedestrian_guide.glb`,
  hawker:          `${GITHUB_BASE}/hawker_stall.glb`,
  construction:    `${GITHUB_BASE}/construction_barrier.glb`,
  pothole:         `${GITHUB_BASE}/pothole.glb`,
  manhole:         `${GITHUB_BASE}/manhole.glb`,
  cyclist:         `${GITHUB_BASE}/cyclist.glb`,
  building_a:      `${GITHUB_BASE}/building_a.glb`,
  building_b:      `${GITHUB_BASE}/building_b.glb`,
  street_lamp:     `${GITHUB_BASE}/street_lamp.glb`,
};

export async function getModelURL(modelKey: string): Promise<string> {
  const url = MODEL_MANIFEST[modelKey];
  if (!url) throw new Error(`Unknown model key: "${modelKey}"`);
  return url;
}
