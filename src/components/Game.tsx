// src/components/Game.tsx
// React Native + expo-gl + Three.js + GLTF models

import React, { useState, useRef, useEffect, useCallback } from "react";
import { View, Text, StyleSheet } from "react-native";
import { GLView } from "expo-gl";
import * as THREE from "three";
import * as Haptics from "expo-haptics";
import { useKeepAwake } from "expo-keep-awake";
import DualJoystick from "./Joystick";
import { LEVELS } from "../utils/levels";
import { loadModel } from "../utils/ModelCache";

// ── Constants ──────────────────────────────────────────────────────────────────
const PLAYER_RADIUS     = 12;
const MOVE_SPEED        = 2.2;   // slightly faster — more responsive feel
const ROTATION_SPEED    = 0.055; // faster look — less frustrating when stuck
const FOG_DENSITY       = 0.010;
const PATH_DRAIN_RATE   = 0.07;  // slightly slower drain — less punishing off-path
const PATH_RECOVER_RATE = 0.06;  // faster recovery — rewards getting back on path
const MAX_CONFIDENCE    = 100;
const TILE_PROXIMITY    = 55;

const OT = {
  ANIMAL: "animal", POTHOLE: "pothole", MANHOLE: "manhole",
  VEHICLE: "vehicle", PEDESTRIAN_BAD: "pedestrian_bad",
  PEDESTRIAN_GOOD: "pedestrian_good", TRAFFIC: "traffic",
  HAWKER: "hawker", CONSTRUCTION: "construction",
  TACTILE_PAVING: "tactile_paving", DESTINATION: "destination",
  CYCLIST: "cyclist",
};

// ── Audio ──────────────────────────────────────────────────────────────────────
function createBeep(ctx: any, freq: number, dur: number, vol = 0.3, type = "sine") {
  try {
    const osc = ctx.createOscillator(), gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    osc.frequency.value = freq; osc.type = type;
    gain.gain.setValueAtTime(vol, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur);
    osc.start(ctx.currentTime); osc.stop(ctx.currentTime + dur);
  } catch (e) {}
}
function playNoise(ctx: any, dur: number, vol = 0.2) {
  try {
    const buf = ctx.createBuffer(1, ctx.sampleRate * dur, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1);
    const src = ctx.createBufferSource(), gain = ctx.createGain();
    src.buffer = buf; src.connect(gain); gain.connect(ctx.destination);
    gain.gain.setValueAtTime(vol, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur);
    src.start(); src.stop(ctx.currentTime + dur);
  } catch (e) {}
}
const playTactile       = (c: any) => createBeep(c, 880, 0.07, 0.18);
const playWarn          = (c: any) => { createBeep(c, 180, 0.4, 0.5, "sawtooth"); playNoise(c, 0.3, 0.3); };
const playBeepBeep      = (c: any) => { createBeep(c, 520, 0.11, 0.55, "square"); setTimeout(() => createBeep(c, 520, 0.11, 0.55, "square"), 200); };
const playBeepBeepUrgent = (c: any) => { createBeep(c, 560, 0.13, 0.7, "square"); setTimeout(() => createBeep(c, 560, 0.13, 0.7, "square"), 190); };
const playCrash         = (c: any) => { playNoise(c, 0.6, 0.7); createBeep(c, 80, 0.5, 0.5, "sawtooth"); };
const playDog           = (c: any) => { createBeep(c, 290, 0.12, 0.3); setTimeout(() => createBeep(c, 240, 0.1, 0.25), 130); };
const playAnx           = (c: any) => createBeep(c, 155, 0.28, 0.13);
const playSuccess       = (c: any) => [523, 659, 784, 1047].forEach((f, i) => setTimeout(() => createBeep(c, f, 0.2, 0.38), i * 115));
const playHawker        = (c: any) => { createBeep(c, 600, 0.06, 0.2); setTimeout(() => createBeep(c, 500, 0.08, 0.2), 120); };
const playConstruction  = (c: any) => { createBeep(c, 200, 0.08, 0.3, "sawtooth"); setTimeout(() => createBeep(c, 200, 0.08, 0.3, "sawtooth"), 120); };

// ── Model config: obstacle type → model key + scale ───────────────────────────
// SCALES: calibrated against actual GLB bounds + internal node transforms.
// headH=46 (eye height). Targets: person=55, car=38, rickshaw=40, dog=18.
// YOFFSETS: center-pivoted models need lifting so base sits at Y=0.
//   pedestrian    — internal scale×100 → actual H=4.3  → scale 13 → 55 units
//   construction  — internal scale×100 → actual H=0.8  → scale 55 → 44 units
//   pothole/manhole — internal rotation−90°+scale → already flat → yOffset 0
//   dog           — center-pivot Y_min=−40.67 → yOffset=9.5 lifts to ground
//   guide/hawker/cyclist — center-pivot → yOffset lifts to ground
const MODEL_CONFIG: Record<string, { key: string; scale: number; yOffset: number }> = {
  [OT.VEHICLE]:         { key: "vehicle",          scale: 1.0,  yOffset: 2.0  }, // rickshaw  52×39×111 native → 52×40×111 world
  [OT.TRAFFIC]:         { key: "traffic",          scale: 0.32, yOffset: 0    }, // car       230×117×489 → 74×38×157
  [OT.CYCLIST]:         { key: "cyclist",          scale: 36,   yOffset: 29.5 }, // center-pivot Y_min=−0.82→ lift 29.5
  [OT.ANIMAL]:          { key: "animal",           scale: 0.23, yOffset: 9.5  }, // dog center-pivot Y_min=−40.67 → lift 9.5
  [OT.PEDESTRIAN_BAD]:  { key: "pedestrian_bad",   scale: 0.294, yOffset: 0.4 }, // new 186-unit model → 0.294×186=55 units
  [OT.PEDESTRIAN_GOOD]: { key: "pedestrian_guide", scale: 7,    yOffset: 30.5 }, // center-pivot Y_min=−4.3 → lift 30.5
  [OT.HAWKER]:          { key: "hawker",           scale: 14,   yOffset: 20.5 }, // center-pivot Y_min=−1.5 → lift 20.5
  [OT.CONSTRUCTION]:    { key: "construction",     scale: 55,   yOffset: 0    }, // node×100→actual 0.8H → 55×0.8=44
  [OT.POTHOLE]:         { key: "pothole",          scale: 33,   yOffset: 0    }, // node rot−90°+×60→flat disc dia 1.2 → ×33=40
  [OT.MANHOLE]:         { key: "manhole",          scale: 55,   yOffset: 0    }, // node rot−90°+×36→flat disc dia 0.72 → ×55=40
};


// ── Procedural fallback mesh ───────────────────────────────────────────────────
function buildFallback(type: string, radius: number): THREE.Group {
  const g = new THREE.Group();
  // All fallback materials are emissive so they're visible regardless of lighting
  if (type === OT.VEHICLE || type === OT.TRAFFIC) {
    const col = type === OT.TRAFFIC ? 0xdc2626 : 0xf97316;
    const b = new THREE.Mesh(
      new THREE.BoxGeometry(radius * 3.2, radius * 1.3, radius * 2),
      new THREE.MeshStandardMaterial({ color: col, emissive: col, emissiveIntensity: 0.4 })
    );
    b.position.y = radius * 0.85; g.add(b);
  } else if (type === OT.CYCLIST) {
    const b = new THREE.Mesh(
      new THREE.BoxGeometry(radius * 2.5, radius * 1.5, radius * 0.8),
      new THREE.MeshStandardMaterial({ color: 0x06b6d4, emissive: 0x06b6d4, emissiveIntensity: 0.4 })
    );
    b.position.y = radius; g.add(b);
  } else if (type === OT.PEDESTRIAN_BAD) {
    // Hostile pedestrian fallback — purple capsule + skin head
    const body = new THREE.Mesh(new THREE.CylinderGeometry(6, 5, 32, 10),
      new THREE.MeshStandardMaterial({ color: 0x7c3aed, emissive: 0x5b21b6, emissiveIntensity: 0.3 }));
    body.position.y = 18; g.add(body);
    const head = new THREE.Mesh(new THREE.SphereGeometry(7, 10, 8),
      new THREE.MeshStandardMaterial({ color: 0xc68642 }));
    head.position.y = 40; g.add(head);
  } else if (type === OT.PEDESTRIAN_GOOD) {
    // Kind stranger — distinctive green glowing helper figure
    // Body: tapered cylinder (shirt)
    const shirt = new THREE.Mesh(new THREE.CylinderGeometry(7, 5.5, 28, 12),
      new THREE.MeshStandardMaterial({ color: 0x16a34a, emissive: 0x15803d, emissiveIntensity: 0.6 }));
    shirt.position.y = 16; g.add(shirt);
    // Legs
    for (const lx of [-4, 4]) {
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(2.5, 2, 18, 8),
        new THREE.MeshStandardMaterial({ color: 0x1e40af }));
      leg.position.set(lx, 0, 0); g.add(leg);
    }
    // Arms (pointing out helpfully)
    for (const [ax, az, ry] of [[-14, 0, 0.4], [14, 0, -0.4]] as any) {
      const arm = new THREE.Mesh(new THREE.CylinderGeometry(1.8, 1.5, 20, 7),
        new THREE.MeshStandardMaterial({ color: 0xc68642 }));
      arm.rotation.z = ax < 0 ? 1.1 : -1.1;
      arm.position.set(ax, 26, 0); g.add(arm);
    }
    // Head
    const head = new THREE.Mesh(new THREE.SphereGeometry(8, 12, 10),
      new THREE.MeshStandardMaterial({ color: 0xd4956a }));
    head.position.y = 46; g.add(head);
    // Glowing aura ring at ground — shows kind nature
    const aura = new THREE.Mesh(new THREE.RingGeometry(10, 16, 24),
      new THREE.MeshBasicMaterial({ color: 0x4ade80, transparent: true, opacity: 0.5, side: THREE.DoubleSide }));
    aura.rotation.x = -Math.PI / 2; aura.position.y = 0.5; g.add(aura);
    // Waving hand indicator (small bright sphere)
    const wave = new THREE.Mesh(new THREE.SphereGeometry(3.5, 8, 6),
      new THREE.MeshStandardMaterial({ color: 0x4ade80, emissive: 0x4ade80, emissiveIntensity: 1.2 }));
    wave.position.set(-16, 32, 0); g.add(wave);
  } else if (type === OT.ANIMAL) {
    const b = new THREE.Mesh(new THREE.SphereGeometry(radius * 0.8, 8, 6),
      new THREE.MeshStandardMaterial({ color: 0xb5651d, emissive: 0xb5651d, emissiveIntensity: 0.3 }));
    b.position.y = radius * 0.6; g.add(b);
  } else if (type === OT.HAWKER) {
    const b = new THREE.Mesh(new THREE.BoxGeometry(radius * 2.5, radius * 1.8, radius * 1.5),
      new THREE.MeshStandardMaterial({ color: 0xdc2626, emissive: 0xdc2626, emissiveIntensity: 0.3 }));
    b.position.y = radius; g.add(b);
  } else if (type === OT.CONSTRUCTION) {
    const b = new THREE.Mesh(new THREE.BoxGeometry(radius * 2.8, radius * 1.2, radius * 1.2),
      new THREE.MeshStandardMaterial({ color: 0xf97316, emissive: 0xf97316, emissiveIntensity: 0.5 }));
    b.position.y = radius * 0.6; g.add(b);
  } else if (type === OT.POTHOLE) {
    // Dark cutout circle — sits just above ground, hides asphalt beneath it
    const pit = new THREE.Mesh(new THREE.CircleGeometry(radius, 24),
      new THREE.MeshStandardMaterial({ color: 0x000000, emissive: 0x000000, emissiveIntensity: 0.0, roughness: 1.0 }));
    pit.rotation.x = -Math.PI / 2; pit.position.y = 0.3; pit.renderOrder = 2; g.add(pit);
    // Crumbled edge ring — broken asphalt look
    const edge = new THREE.Mesh(new THREE.RingGeometry(radius - 4, radius + 5, 24),
      new THREE.MeshStandardMaterial({ color: 0x3a3530, roughness: 1.0 }));
    edge.rotation.x = -Math.PI / 2; edge.position.y = 0.25; edge.renderOrder = 1; g.add(edge);
    // Depth shadow — dark cylinder slightly below surface for depth illusion
    const depth = new THREE.Mesh(new THREE.CylinderGeometry(radius - 3, radius - 5, 6, 24, 1, true),
      new THREE.MeshStandardMaterial({ color: 0x080808, side: THREE.BackSide }));
    depth.position.y = -2; g.add(depth);
  } else if (type === OT.MANHOLE) {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, 2.5, 24),
      new THREE.MeshStandardMaterial({ color: 0x6b7280, emissive: 0x374151, emissiveIntensity: 0.3, metalness: 0.9 }));
    m.position.y = 1.25; g.add(m);
  } else {
    const b = new THREE.Mesh(new THREE.BoxGeometry(radius * 2, radius * 2, radius * 2),
      new THREE.MeshStandardMaterial({ color: 0x6366f1, emissive: 0x6366f1, emissiveIntensity: 0.5 }));
    b.position.y = radius; g.add(b);
  }
  return g;
}

// ── Build scene object ─────────────────────────────────────────────────────────
async function buildMesh(
  scene: THREE.Scene,
  type: string,
  pos: { x: number; y: number },
  radius: number
): Promise<{ obj: THREE.Object3D | null; mixer: THREE.AnimationMixer | null }> {

  if (type === OT.TACTILE_PAVING) {
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(radius * 2, 1.5, radius * 2),
      new THREE.MeshStandardMaterial({
        color: new THREE.Color(0.95, 0.72, 0.02), roughness: 0.78,
        emissive: new THREE.Color(0.95, 0.65, 0.0), emissiveIntensity: 1.5,
      })
    );
    mesh.position.set(pos.x, 0.75, pos.y);
    mesh.receiveShadow = true;
    scene.add(mesh);
    return { obj: mesh, mixer: null };
  }

  if (type === OT.DESTINATION) {
    const g = new THREE.Group();
    const disc = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, 4, 24),
      new THREE.MeshStandardMaterial({ color: 0x22c55e, transparent: true, opacity: 0.65, emissive: 0x15803d, emissiveIntensity: 0.9 }));
    disc.position.y = 2; g.add(disc);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(radius, 3, 8, 32),
      new THREE.MeshStandardMaterial({ color: 0x4ade80, emissive: 0x4ade80, emissiveIntensity: 1.8 }));
    ring.rotation.x = Math.PI / 2; ring.position.y = 4; g.add(ring);
    g.position.set(pos.x, 0, pos.y); scene.add(g);
    return { obj: g, mixer: null };
  }

  const config = MODEL_CONFIG[type];
  if (!config) return { obj: null, mixer: null };
  // pedestrian_guide GLB has 652 accessors / 134 meshes — exceeds expo-gl parse limits.
  // Force to procedural fallback which looks intentional and renders reliably.
  if (type === OT.PEDESTRIAN_GOOD) {
    const obj = buildFallback(type, radius);
    obj.position.set(pos.x, 0, pos.y);
    scene.add(obj);
    return { obj, mixer: null };
  }

  let obj: THREE.Object3D;
  let mixer: THREE.AnimationMixer | null = null;
  const result = await loadModel(config.key); // never throws, returns null on failure
  if (result) {
    const { scene: modelScene, animations } = result;
    modelScene.scale.setScalar(config.scale);
    modelScene.position.set(pos.x, config.yOffset, pos.y);
    modelScene.traverse((c: any) => { c.frustumCulled = false; });

    // Add procedural bicycle frame for cyclist (GLB is rider only, no bicycle)
    if (type === OT.CYCLIST) {
      // Robot GLB faces +Z natively; bike frame is built along X.
      // Rotate robot -PI/2 on Y so it faces +X (same direction as bike frame front).
      modelScene.rotation.y = -Math.PI / 2;
      modelScene.position.set(0, config.yOffset, 0);

      const bikeGroup = new THREE.Group(); // positioned at (0,0,0) — inherited from combined
      const bikeMat = new THREE.MeshStandardMaterial({ color: 0x111827, metalness: 0.75, roughness: 0.25 });
      const rimMat  = new THREE.MeshStandardMaterial({ color: 0x9ca3af, metalness: 0.85, roughness: 0.2 });
      const chainMat= new THREE.MeshStandardMaterial({ color: 0xf59e0b, metalness: 0.6 }); // orange chain/detail
      // Main frame tube (horizontal along X = direction of travel)
      const frame = new THREE.Mesh(new THREE.CylinderGeometry(1.2, 1.2, 30, 8), bikeMat);
      frame.rotation.z = Math.PI / 2; frame.position.set(0, 14, 0); bikeGroup.add(frame);
      // Seat tube (diagonal)
      const seat = new THREE.Mesh(new THREE.CylinderGeometry(1.0, 1.0, 20, 7), bikeMat);
      seat.rotation.z = 0.35; seat.position.set(-4, 20, 0); bikeGroup.add(seat);
      // Front fork
      const fork = new THREE.Mesh(new THREE.CylinderGeometry(0.8, 0.8, 18, 7), bikeMat);
      fork.rotation.z = 0.25; fork.position.set(13, 10, 0); bikeGroup.add(fork);
      // Wheels (torus, spinning plane = XY, axis = Z)
      for (const wx of [-13, 13]) {
        const wheel = new THREE.Mesh(new THREE.TorusGeometry(10, 1.4, 8, 20), rimMat);
        wheel.rotation.y = Math.PI / 2; wheel.position.set(wx, 10, 0); bikeGroup.add(wheel);
        // Spoke cross
        for (const rz of [0, Math.PI/2]) {
          const spoke = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.4, 18, 5), bikeMat);
          spoke.rotation.z = rz; spoke.position.set(wx, 10, 0); bikeGroup.add(spoke);
        }
      }
      // Handlebars (along Z at front)
      const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.8, 0.8, 16, 7), bikeMat);
      bar.rotation.x = Math.PI / 2; bar.position.set(14, 26, 0); bikeGroup.add(bar);
      // Chain ring (orange detail at center)
      const chain = new THREE.Mesh(new THREE.TorusGeometry(5, 1.0, 6, 14), chainMat);
      chain.rotation.y = Math.PI / 2; chain.position.set(0, 10, 0); bikeGroup.add(chain);

      const combined = new THREE.Group();
      combined.add(modelScene);
      combined.add(bikeGroup);
      combined.position.set(pos.x, 0, pos.y);
      combined.traverse((c: any) => { c.frustumCulled = false; });
      obj = combined;
    } else {
      obj = modelScene;
    }
    // Play walk animation if available
    if (animations && animations.length > 0) {
      mixer = new THREE.AnimationMixer(modelScene);
      const clip = animations[animations.length - 1];
      // Strip ROOT BONE position track only.
      // Confirmed: rp_nathan _root bone translates Z=0→287 per cycle (84 world units
      // at scale 0.294) → character drifts and teleports back each loop → "random appearance".
      // Hip bone bobbing (small Y/X translations) is intentionally kept for natural motion.
      const inPlaceTracks = clip.tracks.filter((t: any) =>
        !t.name.toLowerCase().endsWith('_root.position')
      );
      const inPlaceClip = new THREE.AnimationClip(clip.name, clip.duration, inPlaceTracks);
      const action = mixer.clipAction(inPlaceClip);
      action.play();
      mixer.update(0); // pre-compute frame 0 — prevents T-pose flash on first render
      if (__DEV__) console.log(`[Game] Animation: ${clip.name} for ${config.key} (${inPlaceTracks.length}/${clip.tracks.length} tracks)`);
    }
  } else {
    obj = buildFallback(type, radius);
    obj.position.set(pos.x, 0, pos.y);
  }
  scene.add(obj);
  return { obj, mixer };
}

// ── Props ──────────────────────────────────────────────────────────────────────
interface GameProps {
  levelIndex: number;
  onExit: () => void;
  onLevelComplete: (nextIndex: number) => void;
}

export default function Game({ levelIndex, onExit, onLevelComplete }: GameProps) {
  useKeepAwake();

  const level = LEVELS[levelIndex];
  const moveInputRef   = useRef({ x: 0, y: 0 });
  const stickInputRef  = useRef({ x: 0, y: 0 });
  const playerStateRef = useRef({ position: { ...level.startPos }, rotation: -Math.PI / 2, pitch: 0 });
  const movingObsRef   = useRef<any[]>([]);
  const confidenceRef  = useRef(MAX_CONFIDENCE);
  const gameStateRef   = useRef("playing");
  const audioCtxRef    = useRef<any>(null);
  const timers         = useRef({ tactile: 0, warn: 0, honk: 0, anx: 0 });

  const [gameState, setGameState]   = useState("playing");
  const [confidence, setConfidence] = useState(MAX_CONFIDENCE);
  const [message, setMessage]       = useState<string | null>(null);
  const [onPath, setOnPath]         = useState(true);

  const getAudio = useCallback(() => {
    if (!audioCtxRef.current) {
      try {
        const AC = (globalThis as any).AudioContext || (globalThis as any).webkitAudioContext;
        if (AC) {
          audioCtxRef.current = new AC();
          // Resume immediately — required on Android after user gesture
          if (audioCtxRef.current.state === 'suspended') {
            audioCtxRef.current.resume().catch(() => {});
          }
        }
      } catch (e) {}
    }
    return audioCtxRef.current;
  }, []);

  useEffect(() => { gameStateRef.current = gameState; }, [gameState]);

  const initMoving = useCallback(() => {
    movingObsRef.current = level.movingObstacles.map((o: any) => ({
      ...o,
      pos: o.travelStart ? { ...o.travelStart } : o.spawnPos ? { ...o.spawnPos } : { x: 0, y: 0 },
      waiting: false, waitTimer: 0, pedDir: 1, pedTimer: 0, pedPaused: false,
      dogDir: 1, dogTimer: 0, dogPaused: false,
      dogPauseLen: 1.0 + Math.random(), dogBurstLen: 0.8 + Math.random(),
    }));
  }, [level]);
  useEffect(() => { initMoving(); }, [initMoving]);

  const distToPath = useCallback((pos: { x: number; y: number }) => {
    let min = Infinity;
    for (const t of level.pathTiles) {
      const d = Math.hypot(pos.x - t.x, pos.y - t.y);
      if (d < min) min = d;
    }
    for (const z of (level.zebraCrossings || [])) {
      const hit = z.axis === "x"
        ? Math.abs(pos.y - z.cy) < z.roadWidth / 2 + 10 && Math.abs(pos.x - z.cx) < 60
        : Math.abs(pos.x - z.cx) < z.roadWidth / 2 + 10 && Math.abs(pos.y - z.cy) < 60;
      if (hit) min = 0;
    }
    return min;
  }, [level]);

  const collide = useCallback((pos: { x: number; y: number }, r: number, list: any[]) => {
    for (const o of list) {
      const p = o.pos || o.position;
      if (Math.hypot(pos.x - p.x, pos.y - p.y) < r + o.radius) return o;
    }
    return null;
  }, []);

  // ── expo-gl context ────────────────────────────────────────────────────────
  const onContextCreate = useCallback(async (gl: any) => {
    const W = gl.drawingBufferWidth;
    const H = gl.drawingBufferHeight;

    // ── BUG 1 FIX: Three.js needs a mock canvas + explicit context ───────────
    // gl from expo-gl IS the WebGL context, NOT a canvas element.
    // Passing gl as canvas makes Three.js call gl.getContext() → crash.
    // Solution: provide a mock canvas that returns gl from getContext(),
    // AND pass context: gl so Three.js skips its own context creation.
    const mockCanvas = {
      width: W,
      height: H,
      style: {},
      addEventListener: () => {},
      removeEventListener: () => {},
      clientHeight: H,
      clientWidth: W,
      getContext: () => gl,
    };

    const renderer = new THREE.WebGLRenderer({
      canvas: mockCanvas as any,
      context: gl,
      antialias: false,
      powerPreference: "high-performance",
    });
    renderer.setSize(W, H);
    renderer.setPixelRatio(1);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    // Force CPU skinning — expo-gl doesn't support gl.pixelStorei(UNPACK_ALIGNMENT)
    // which Three.js needs for GPU bone texture. CPU skinning avoids this entirely.
    (renderer as any).capabilities.maxVertexTextures = 0;

    // ── Scene ──────────────────────────────────────────────────────────────
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x1a1a2e);
    scene.fog = new THREE.FogExp2(0x0f1117, FOG_DENSITY);

    // Portrait mode: swap aspect ratio so game fills portrait screen correctly
    const aspect = W > H ? W / H : H / W;
    const camera = new THREE.PerspectiveCamera(72, W / H, 0.5, 1200);

    scene.add(new THREE.AmbientLight(0xffffff, 1.2));
    const sun = new THREE.DirectionalLight(0xffffff, 1.8);
    sun.position.set(300, 400, 200); sun.castShadow = true; scene.add(sun);
    const bodyLight = new THREE.PointLight(0xffffff, 3.0, 800); scene.add(bodyLight);
    const hazeLight = new THREE.PointLight(0xffffff, 2.0, 600); scene.add(hazeLight);

    // ── Road & environment ──────────────────────────────────────────────────
    // ── Procedural asphalt: diffuse + normal map ─────────────────────────
    // TextureLoader doesn't work in expo-gl without bundled image assets.
    // We generate DataTextures using multi-frequency hash noise (resembles
    // real asphalt grain with embedded aggregate particles).
    // ── Procedural asphalt + normal map using RGBAFormat ─────────────────
    // RGBFormat is deprecated in Three.js r152+ — must use RGBAFormat (4 bytes/pixel).
    // 128x128 keeps generation fast on mobile; tiled 20x20 gives fine grain at road scale.
    const ATEX = 128;
    const h = (n: number) => { n = ((n >>> 0) * 2246822519 + 2654435769) >>> 0; return (n & 0xff) / 255; };
    const hf = new Float32Array(ATEX * ATEX);
    // Diffuse: RGBA
    const diffData = new Uint8Array(ATEX * ATEX * 4);
    for (let y = 0; y < ATEX; y++) {
      for (let x = 0; x < ATEX; x++) {
        const i  = y * ATEX + x;
        const n0 = h(i * 7 + 1);
        const n1 = h(Math.floor(x/4) * 13 + Math.floor(y/4) * 97 + 3);
        const n2 = h(Math.floor(x/2) * 41 + Math.floor(y/2) * 29 + 7);
        hf[i] = n0 * 0.5 + n1 * 0.35 + n2 * 0.15;
        const base  = 62 + Math.floor(n1 * 16);
        const grain = Math.floor(n0 * 10);
        const stone = n2 > 0.84 ? 24 : 0;
        const v = Math.min(255, base + grain + stone);
        diffData[i*4]   = v;
        diffData[i*4+1] = v;
        diffData[i*4+2] = Math.min(255, v + 5);
        diffData[i*4+3] = 255;
      }
    }
    // Normal map: RGBA, derived from height field
    const normalData = new Uint8Array(ATEX * ATEX * 4);
    for (let y = 0; y < ATEX; y++) {
      for (let x = 0; x < ATEX; x++) {
        const i = y * ATEX + x;
        const dX = (hf[y*ATEX+Math.min(x+1,ATEX-1)] - hf[y*ATEX+Math.max(x-1,0)]) * 3.0;
        const dY = (hf[Math.min(y+1,ATEX-1)*ATEX+x] - hf[Math.max(y-1,0)*ATEX+x]) * 3.0;
        const len = Math.sqrt(dX*dX + dY*dY + 1);
        normalData[i*4]   = Math.floor((-dX/len * 0.5 + 0.5) * 255);
        normalData[i*4+1] = Math.floor((-dY/len * 0.5 + 0.5) * 255);
        normalData[i*4+2] = Math.floor((1.0/len * 0.5 + 0.5) * 255);
        normalData[i*4+3] = 255;
      }
    }
    const asphaltTex = new THREE.DataTexture(diffData,   ATEX, ATEX, THREE.RGBAFormat);
    const asphaltNrm = new THREE.DataTexture(normalData, ATEX, ATEX, THREE.RGBAFormat);
    asphaltTex.wrapS = asphaltTex.wrapT = THREE.RepeatWrapping; asphaltTex.repeat.set(20, 20); asphaltTex.needsUpdate = true;
    asphaltNrm.wrapS = asphaltNrm.wrapT = THREE.RepeatWrapping; asphaltNrm.repeat.set(20, 20); asphaltNrm.needsUpdate = true;
    const asphaltMat = new THREE.MeshStandardMaterial({
      map: asphaltTex, normalMap: asphaltNrm,
      normalScale: new THREE.Vector2(0.6, 0.6),
      roughness: 0.95, metalness: 0.0,
    });
    const road = new THREE.Mesh(new THREE.PlaneGeometry(900, 1200), asphaltMat);
    road.rotation.x = -Math.PI / 2; road.position.set(450, -0.5, 500);
    road.receiveShadow = true; scene.add(road);
    // Concrete pavement — lighter warm gray, RGBA
    const concData = new Uint8Array(ATEX * ATEX * 4);
    for (let i = 0; i < ATEX * ATEX; i++) {
      const v = 155 + Math.floor(h(i*11+5) * 30);
      concData[i*4] = v+5; concData[i*4+1] = v; concData[i*4+2] = v-8; concData[i*4+3] = 255;
    }
    const concTex = new THREE.DataTexture(concData, ATEX, ATEX, THREE.RGBAFormat);
    concTex.wrapS = concTex.wrapT = THREE.RepeatWrapping;
    concTex.repeat.set(8, 80); concTex.needsUpdate = true;

    // Pavements at x=185 (left) and x=715 (right) — wider road x=205 to x=695
    const paveMat = new THREE.MeshStandardMaterial({ map: concTex, roughness: 0.88 });
    for (const lx of [185, 715]) {
      const pave = new THREE.Mesh(new THREE.BoxGeometry(80, 3, 1200), paveMat);
      pave.position.set(lx, 1.5, 500); pave.receiveShadow = true; scene.add(pave);
    }

    // Building colors from GLB materials:
    // building_a: wall=0x8c8c8c (gray), roof=0x178252 (green), window=0x82c4ff (blue), border=0x484b54
    // building_b: apartment block → beige/sandy 0xb8a685 (texture-stripped fallback)
    for (const b of [
      { x: 110, zStart: -50,  w: 160, d: 160, h: 220, wall: 0x8c8c8c, roof: 0x178252 },
      { x:  90, zStart: 160,  w: 140, d: 140, h: 300, wall: 0xb8a685, roof: 0x484b54 },
      { x: 120, zStart: 360,  w: 180, d: 150, h: 180, wall: 0x8c8c8c, roof: 0x178252 },
      { x: 100, zStart: 570,  w: 160, d: 140, h: 280, wall: 0xb8a685, roof: 0x484b54 },
      { x: 790, zStart: -50,  w: 160, d: 160, h: 240, wall: 0x8c8c8c, roof: 0x178252 },
      { x: 810, zStart: 160,  w: 140, d: 140, h: 320, wall: 0xb8a685, roof: 0x484b54 },
      { x: 800, zStart: 360,  w: 160, d: 150, h: 190, wall: 0x8c8c8c, roof: 0x178252 },
      { x: 790, zStart: 570,  w: 150, d: 140, h: 360, wall: 0xb8a685, roof: 0x484b54 },
    ]) {
      // Main wall
      const wallMesh = new THREE.Mesh(new THREE.BoxGeometry(b.w, b.h - 12, b.d),
        new THREE.MeshStandardMaterial({ color: b.wall, roughness: 0.88 }));
      wallMesh.position.set(b.x, (b.h - 12) / 2, b.zStart + b.d / 2);
      wallMesh.castShadow = true; wallMesh.receiveShadow = true; scene.add(wallMesh);
      // Roof slab
      const roofMesh = new THREE.Mesh(new THREE.BoxGeometry(b.w + 8, 14, b.d + 8),
        new THREE.MeshStandardMaterial({ color: b.roof, roughness: 0.75 }));
      roofMesh.position.set(b.x, b.h - 6, b.zStart + b.d / 2);
      roofMesh.castShadow = true; scene.add(roofMesh);
      // Windows — 2 columns × 3 rows of blue windows on the road-facing side
      const winMat = new THREE.MeshStandardMaterial({ color: 0x82c4ff, emissive: 0x224466, emissiveIntensity: 0.4 });
      const roadFaceZ = b.zStart + b.d; // face toward road
      const roadFaceX = b.x > 400 ? b.x - b.w/2 : b.x + b.w/2; // inner face
      for (let row = 0; row < 3; row++) {
        for (let col = 0; col < 2; col++) {
          const win = new THREE.Mesh(new THREE.BoxGeometry(2, 18, 24), winMat);
          const wz = b.zStart + 30 + row * (b.d - 30) / 3;
          const wy = 30 + col * 60;
          win.position.set(roadFaceX, wy, wz);
          scene.add(win);
        }
      }
    }

    // ── Continuous boundary walls — invisible hard stops ──────────────────
    // Discrete buildings leave 50-60 unit Z-gaps the player walks through.
    // These invisible planes close every gap and act as the true collider wall.
    // Placed at x=240 (left) and x=660 (right) = inner faces of buildings.
    const wallMatInvis = new THREE.MeshStandardMaterial({ color: 0x1a1a2e, visible: false });
    const leftWall  = new THREE.Mesh(new THREE.BoxGeometry(2, 400, 1200), wallMatInvis);
    const rightWall = new THREE.Mesh(new THREE.BoxGeometry(2, 400, 1200), wallMatInvis);
    leftWall.position.set(207, 200, 500); rightWall.position.set(693, 200, 500);
    scene.add(leftWall); scene.add(rightWall);
    // Filler wall strips between building gaps (visible — same texture as buildings)
    const fillMat = new THREE.MeshStandardMaterial({ color: 0x7a7a7a, roughness: 0.9 });
    const leftGaps  = [[110,50],[300,60],[510,60],[720,50]] as [number,number][];
    const rightGaps = [[110,50],[300,60],[510,60],[720,50]] as [number,number][];
    for (const [gz, gl] of leftGaps) {
      const filler = new THREE.Mesh(new THREE.BoxGeometry(120, 200, gl), fillMat);
      filler.position.set(110, 100, gz + gl/2); scene.add(filler);
    }
    for (const [gz, gl] of rightGaps) {
      const filler = new THREE.Mesh(new THREE.BoxGeometry(120, 200, gl), fillMat);
      filler.position.set(790, 100, gz + gl/2); scene.add(filler);
    }

    // Procedural street lamps (skip GLTF for lamps to save memory)
    const poleMat = new THREE.MeshStandardMaterial({ color: 0x2a2a2a, metalness: 0.7 });
    for (let z = 50; z < 950; z += 200) {
      for (const lx of [205, 695]) {
        const pole = new THREE.Mesh(new THREE.CylinderGeometry(2.5, 3, 140, 6), poleMat);
        pole.position.set(lx, 70, z); scene.add(pole);
        const light = new THREE.PointLight(0xffffff, 1.6, 500);
        light.position.set(lx, 128, z); scene.add(light);
      }
    }

    // ── Game objects ────────────────────────────────────────────────────────
    // Build tactile tiles — skip any tile inside a vehicle crossing zone
    // (those zones get zebra stripes instead)
    // Exclusion radius = roadWidth/2 + 55 ≈ cy±95 for roadWidth=80.
    // Covers the road surface (vehicles at cy±90) with small clearance.
    // Zebra depth = 2×95 = 190 units ≈ 2.5 car-lane widths ("4 cars" = 2+2 lanes).
    const crossingZones = (level.zebraCrossings || []).map((z: any) => ({
      minY: z.cy - z.roadWidth / 2 - 70,
      maxY: z.cy + z.roadWidth / 2 + 70,
    }));
    const isInCrossing = (t: { x: number; y: number }) =>
      crossingZones.some((z: any) => t.y >= z.minY && t.y <= z.maxY);

    await Promise.all(
      level.pathTiles
        .filter((t: any) => !isInCrossing(t))
        .map((t: any) => buildMesh(scene, OT.TACTILE_PAVING, t, 16))
    );

    // ── Zebra crossings ────────────────────────────────────────────────────
    // ── Road layout constants ─────────────────────────────────────────────
    // Road: x=210 to x=690 = 480 units. Centre x=450.
    // Vehicles: dir=+1 lane at z=cy+55, dir=-1 lane at z=cy-55.
    // Lane divider: dotted white line at z=cy, running full road width (along X).
    const ROAD_X_START = 210, ROAD_X_END = 690;
    const ROAD_X_SPAN  = ROAD_X_END - ROAD_X_START; // 480
    const ROAD_X_CX    = (ROAD_X_START + ROAD_X_END) / 2; // 450

    // ── Zebra crossings = extension of yellow path ───────────────────────
    // The tile exclusion zone = cy ± (roadWidth/2 + 110).
    // The zebra must cover THIS EXACT ZONE so the player always sees either
    // yellow tiles or white zebra stripes — no gap, ever.
    //
    // Width (X): 3 × tile width = 3 × 32 = 96 units, centered at zc.cx
    //            (same X as the tactile path, so it's a direct visual continuation)
    // Depth (Z): = 2 × (roadWidth/2 + 110) = roadWidth + 220
    //            (matches the tile exclusion zone exactly)
    //
    // Stripes: period = 30 units (stripe=17, gap=13), filling full depth.
    const ZEBRA_TILE_W = 96;  // 3 × tactile tile diameter (3 × 32)
    const zebraStripeMat = new THREE.MeshStandardMaterial({
      color: 0xf0f0ec, roughness: 0.80,
      emissive: 0xf0f0ec, emissiveIntensity: 0.18,
    });

    for (const zc of (level.zebraCrossings || [])) {
      // Depth = full exclusion zone so zebra replaces every removed tile
      const exclRadius  = (zc.roadWidth || 80) / 2 + 70;
      const zebraDepth  = exclRadius * 2;                        // e.g. 300 for rw=80
      // Stripes: fixed 30-unit period, filling zebraDepth
      const numStripes  = Math.round(zebraDepth / 30);           // e.g. 10
      const period      = zebraDepth / numStripes;
      const stripeD     = Math.round(period * 0.56);
      const stripeGap   = period - stripeD;
      const startZ      = zc.cy - zebraDepth / 2 + stripeD / 2;
      // X position: centered on cx (tactile path), width = 3× tile
      const zebraCX     = zc.cx;
      for (let i = 0; i < numStripes; i++) {
        const sz = startZ + i * (stripeD + stripeGap);
        const stripe = new THREE.Mesh(
          new THREE.BoxGeometry(ZEBRA_TILE_W, 0.65, stripeD),
          zebraStripeMat
        );
        stripe.position.set(zebraCX, 0.15, sz);
        scene.add(stripe);
      }
    }

    // ── Lane divider: dotted white line parallel to zebra stripes ────────
    // One dotted line per crossing at z=zc.cy — exactly midway between the
    // two vehicle lanes (cy+55 and cy-55). Runs full road width along X.
    // Parallel to zebra stripes (both run along X), not perpendicular.
    // No continuous line — only at road crossings where lanes are defined.
    const dashMat = new THREE.MeshStandardMaterial({
      color: 0xffffff, roughness: 0.75,
      emissive: 0xffffff, emissiveIntensity: 0.15,
    });
    const DASH_LEN = 45, DASH_GAP = 25; // dash 45 wide, 25 gap, runs along X
    const seenCY = new Set<number>();
    for (const zc of (level.zebraCrossings || [])) {
      if (seenCY.has(zc.cy)) continue;
      seenCY.add(zc.cy);
      // Draw dashes from x=ROAD_X_START to ROAD_X_END
      for (let dx = ROAD_X_START; dx < ROAD_X_END; dx += DASH_LEN + DASH_GAP) {
        const dash = new THREE.Mesh(new THREE.BoxGeometry(DASH_LEN, 0.55, 3), dashMat);
        dash.position.set(dx + DASH_LEN / 2, 0.16, zc.cy);
        scene.add(dash);
      }
    }

    await Promise.all(level.staticObstacles.map((o: any) => buildMesh(scene, o.type, o.position, o.radius)));
    await buildMesh(scene, OT.DESTINATION, level.destinationPos, 42);

    const destLight = new THREE.PointLight(0x22c55e, 2.0, 220);
    destLight.position.set(level.destinationPos.x, 30, level.destinationPos.y);
    scene.add(destLight);

    const movingMeshes: Record<string, THREE.Object3D | null> = {};
    const movingMixers: Map<string, THREE.AnimationMixer> = new Map();
    await Promise.all(movingObsRef.current.map(async (o: any) => {
      const built = await buildMesh(scene, o.type, o.pos, o.radius);
      movingMeshes[o.id] = built.obj;
      if (built.mixer) movingMixers.set(o.id, built.mixer);
    }));

    const playerGroup = new THREE.Group();
    scene.add(playerGroup);
    // Footprint ring — shows player collision radius on the ground
    // Helps player understand their size relative to obstacles and vehicles
    const footprintRing = new THREE.Mesh(
      new THREE.RingGeometry(PLAYER_RADIUS - 2, PLAYER_RADIUS, 24),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.18, side: THREE.DoubleSide })
    );
    footprintRing.rotation.x = -Math.PI / 2;
    footprintRing.position.y = 0.3;
    playerGroup.add(footprintRing);
    // Small direction arrow (shows which way player faces)
    const arrowGeo = new THREE.ConeGeometry(3, 12, 8);
    const arrowMesh = new THREE.Mesh(arrowGeo,
      new THREE.MeshBasicMaterial({ color: 0xffd700, transparent: true, opacity: 0.55 })
    );
    arrowMesh.rotation.z = -Math.PI / 2; // point forward along +X
    arrowMesh.position.set(PLAYER_RADIUS + 4, 1, 0);
    playerGroup.add(arrowMesh);

    // ── Game loop ────────────────────────────────────────────────────────────
    // LETHAL: instant game-over on touch
    // ANIMAL (dog) removed from LETHAL — biting now drains confidence heavily
    // but doesn't instantly kill. More forgiving and more realistic.
    const LETHAL = [OT.MANHOLE, OT.POTHOLE, OT.TRAFFIC, OT.CYCLIST];
    let msgT: any = null;
    const safeMsg = (txt: string, dur = 2200) => {
      if (msgT) clearTimeout(msgT);
      setMessage(txt);
      msgT = setTimeout(() => setMessage(null), dur);
    };

    let running = true;
    let lastTime = performance.now();
    // Animation mixers keyed by obstacle ID for pause/resume control

    const animate = () => {
      if (!running) return;
      requestAnimationFrame(animate);

      if (gameStateRef.current !== "playing") {
        renderer.render(scene, camera);
        gl.endFrameEXP();
        return;
      }

      const now = performance.now();
      const delta = Math.min((now - lastTime) / 1000, 0.05);
      lastTime = now;
      const fs = delta * 60;
      const prev = playerStateRef.current;

      movingObsRef.current.forEach((o: any) => {
        const m = movingMeshes[o.id];
        const prevX = o.pos.x, prevY = o.pos.y;
        const isVeh = o.type === OT.VEHICLE || o.type === OT.TRAFFIC || o.type === OT.CYCLIST || (o.type === OT.PEDESTRIAN_BAD && !!o.travelStart);
        const isPed = (o.type === OT.PEDESTRIAN_BAD || o.type === OT.PEDESTRIAN_GOOD) && !o.travelStart;
        const isDog = o.type === OT.ANIMAL;

        if (isVeh) {
          if (o.waiting) {
            o.waitTimer = (o.waitTimer || 0) + delta;
            if (o.waitTimer >= (o.gapDelay || 2.5)) {
              o.pos.x = o.travelStart.x; o.pos.y = o.travelStart.y;
              o.waiting = false; o.waitTimer = 0;
            }
            if (m) m.position.set(-9999, 0, -9999);
            return;
          }
          const spd = o.speed * 2.2 * fs;
          o.axis === "y" ? (o.pos.y += o.dir * spd) : (o.pos.x += o.dir * spd);
          const past = o.axis === "y"
            ? (o.dir > 0 ? o.pos.y > o.travelEnd.y : o.pos.y < o.travelEnd.y)
            : (o.dir > 0 ? o.pos.x > o.travelEnd.x : o.pos.x < o.travelEnd.x);
          if (past) { o.waiting = true; o.waitTimer = 0; }
          if (m) {
            // Vehicles travel on dedicated tracks: dir=+1 at cy+55, dir=-1 at cy-55
            // No extra render offset needed — track Y IS the lane position.
            const clampedX = Math.max(208, Math.min(692, o.pos.x));
            m.position.x = clampedX;
            m.position.z = o.pos.y;
            // Vehicles (rickshaw/car) face +Z natively → PI/2 rotates +Z to +X for rightward travel
            // Cyclists: procedural bike frame is built along local X axis → rotation 0 faces +X directly
            if (o.type === OT.CYCLIST) {
              m.rotation.y = o.axis === "y" ? (o.dir > 0 ? -Math.PI/2 : Math.PI/2) : (o.dir > 0 ? 0 : Math.PI);
            } else {
              m.rotation.y = o.axis === "y" ? (o.dir > 0 ? 0 : Math.PI) : (o.dir > 0 ? Math.PI/2 : -Math.PI/2);
            }
          }
        } else if (isPed) {
          if (!o.pedDir) o.pedDir = 1;
          o.pedTimer += delta;
          const ref = o.spawnPos || { x: o.pos.x, y: o.pos.y };
          if (o.pedPaused) {
            if (o.pedTimer > 1.0) { o.pedPaused = false; o.pedDir *= -1; o.pedTimer = 0; }
          } else {
            const spd = o.speed * 1.4 * fs; // boosted so movement is clearly visible
            o.axis === "y" ? (o.pos.y += o.pedDir * spd) : (o.pos.x += o.pedDir * spd);
            const half = (o.range || 80) / 2;
            if (o.axis === "y" ? Math.abs(o.pos.y - ref.y) > half : Math.abs(o.pos.x - ref.x) > half) {
              o.pedPaused = true; o.pedTimer = 0;
            }
          }
          if (m) {
            m.position.x = o.pos.x; m.position.z = o.pos.y;
            const dx = o.pos.x - prevX, dz = o.pos.y - prevY;
            if (Math.abs(dx) > 0.001 || Math.abs(dz) > 0.001) {
              // Smooth rotation: slerp toward target angle instead of instant snap.
              // Without this, pedestrian snaps 180° instantly when direction reverses.
              const targetRot = -Math.atan2(dz, dx) + Math.PI / 2;
              // Shortest-path angular interpolation
              let diff = targetRot - m.rotation.y;
              while (diff > Math.PI)  diff -= Math.PI * 2;
              while (diff < -Math.PI) diff += Math.PI * 2;
              m.rotation.y += diff * Math.min(1.0, 8.0 * delta); // lerp speed: 8 rad/s
            }
          }
          // Pause walk animation when stationary, resume when moving
          const pedMixer = movingMixers.get(o.id);
          if (pedMixer) pedMixer.timeScale = o.pedPaused ? 0 : 1;
        } else if (isDog) {
          o.dogTimer += delta;
          const ref = o.spawnPos || { x: o.pos.x, y: o.pos.y };
          if (o.dogPaused) {
            if (o.dogTimer > o.dogPauseLen) { o.dogPaused = false; o.dogTimer = 0; }
          } else {
            const spd = o.speed * 0.7 * fs;
            o.axis === "y" ? (o.pos.y += o.dogDir * spd) : (o.pos.x += o.dogDir * spd);
            const half = (o.range || 80) / 2;
            if ((o.axis === "y" ? Math.abs(o.pos.y - ref.y) > half : Math.abs(o.pos.x - ref.x) > half) || o.dogTimer > (o.dogBurstLen || 1.5)) {
              o.dogPaused = true; o.dogTimer = 0;
              o.dogPauseLen = 0.8 + Math.random() * 1.2;
              o.dogBurstLen = 0.8 + Math.random();
              o.dogDir *= -1;
            }
          }
          if (m) {
            m.position.x = o.pos.x; m.position.z = o.pos.y;
            const dx = o.pos.x - prevX, dz = o.pos.y - prevY;
            if (Math.abs(dx) > 0.001 || Math.abs(dz) > 0.001) {
              const targetRot = -Math.atan2(dz, dx) + Math.PI / 2;
              let diff = targetRot - m.rotation.y;
              while (diff > Math.PI)  diff -= Math.PI * 2;
              while (diff < -Math.PI) diff += Math.PI * 2;
              m.rotation.y += diff * Math.min(1.0, 12.0 * delta); // dogs turn faster
            }
          }
        }
      });

      const mIn = moveInputRef.current;
      const sIn = stickInputRef.current;
      let newRot = prev.rotation + sIn.x * ROTATION_SPEED * fs;
      let newPitch = prev.pitch;
      if (sIn.y > 0.1) newPitch = Math.min(Math.PI * 35/180, newPitch + sIn.y * 0.04 * fs);
      else if (sIn.y < -0.1) newPitch = Math.max(0, newPitch + sIn.y * 0.04 * fs);

      let newX = prev.position.x, newY = prev.position.y;
      if (Math.abs(mIn.x) > 0.05 || Math.abs(mIn.y) > 0.05) {
        newX += (Math.cos(newRot) * -mIn.y + Math.cos(newRot + Math.PI/2) * mIn.x) * MOVE_SPEED * fs;
        newY += (Math.sin(newRot) * -mIn.y + Math.sin(newRot + Math.PI/2) * mIn.x) * MOVE_SPEED * fs;
      }
      // Hard building boundaries — inner wall faces at x=240 (left) and x=660 (right)
      // Pavement (x=170-250 left, x=650-730 right) is accessible, buildings are not.
      // This clamp matches the invisible wall colliders placed in the scene.
      newX = Math.max(208, Math.min(692, newX));
      // Z (y in game coords) boundaries — don't fall off the map ends
      newY = Math.max(-60, Math.min(980, newY));

      const newPos = { x: newX, y: newY };
      const pathDist = distToPath(newPos);
      const isOnPath = pathDist < TILE_PROXIMITY;
      setOnPath(isOnPath);

      if (isOnPath) {
        confidenceRef.current = Math.min(MAX_CONFIDENCE, confidenceRef.current + PATH_RECOVER_RATE * fs);
        if ((Math.abs(mIn.x) > 0.05 || Math.abs(mIn.y) > 0.05) && now - timers.current.tactile > 330) {
          try { playTactile(getAudio()); } catch (e) {}
          timers.current.tactile = now;
        }
      } else {
        confidenceRef.current = Math.max(0, confidenceRef.current - PATH_DRAIN_RATE * fs);
        if (now - timers.current.anx > 1900 && confidenceRef.current < 55) {
          try { playAnx(getAudio()); } catch (e) {}
          timers.current.anx = now;
        }
      }
      setConfidence(Math.round(confidenceRef.current));

      if (confidenceRef.current <= 0) {
        gameStateRef.current = "gameover"; setGameState("gameover");
        setMessage("You lost your way in the darkness…"); return;
      }

      const dp = level.destinationPos;
      if (Math.hypot(newPos.x - dp.x, newPos.y - dp.y) < 42 + PLAYER_RADIUS) {
        try { playSuccess(getAudio()); } catch (e) {}
        try { Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success); } catch (e) {}
        gameStateRef.current = "complete"; setGameState("complete");
      }

      // Honk when a vehicle is approaching and close enough to hear.
      // Vehicles now travel at cy±90, so player-vehicle Y separation can be 90+ units.
      // Old Y-separation guard (radius+45≈79) was filtering them all out → no beep.
      // Fix: use simple 2D distance check only. Any vehicle within 220 units triggers honk.
      for (const o of movingObsRef.current) {
        if (o.waiting || !(o.type === OT.VEHICLE || o.type === OT.TRAFFIC || o.type === OT.CYCLIST)) continue;
        const dist = Math.hypot(newPos.x - o.pos.x, newPos.y - o.pos.y);
        if (dist > 220 || dist <= o.radius + PLAYER_RADIUS) continue;
        const urgent = dist < 90;
        if (now - timers.current.honk > (urgent ? 500 : 1000)) {
          try { urgent ? playBeepBeepUrgent(getAudio()) : playBeepBeep(getAudio()); } catch (e) {}
          timers.current.honk = now;
        }
      }

      // ── Pulse footprint ring color: white=safe, yellow=near vehicle, red=danger
      let closestVehDist = 9999;
      for (const o of movingObsRef.current) {
        if (o.waiting) continue;
        if (o.type !== OT.VEHICLE && o.type !== OT.TRAFFIC && o.type !== OT.CYCLIST) continue;
        closestVehDist = Math.min(closestVehDist, Math.hypot(prev.position.x - o.pos.x, prev.position.y - o.pos.y) - o.radius);
      }
      const ringColor = closestVehDist < 15 ? 0xff2222 : closestVehDist < 50 ? 0xffaa00 : 0xffffff;
      const ringOpacity = closestVehDist < 15 ? 0.55 : closestVehDist < 50 ? 0.35 : 0.18;
      (footprintRing.material as any).color.set(ringColor);
      (footprintRing.material as any).opacity = ringOpacity;

      // ── Vehicle proximity warning ─────────────────────────────────────────
      // Separate from lethal collision: warn when vehicle is close but not yet touching.
      // Grace zone: if player is ON the tactile path, require 20 extra units of clearance
      // before triggering vehicle hit — prevents "hit while clearly past the road" issue.
      const onTactileNow = isOnPath;
      const movingActive = movingObsRef.current.filter((o: any) => !o.waiting);

      // ── Collision detection ────────────────────────────────────────────────
      // For vehicles: only lethal if player is not on tactile safety zone
      // (or very deep inside the vehicle model — radius ÷ 2)
      let hit: any = null;
      for (const o of [...level.staticObstacles, ...movingActive]) {
        const p = o.pos || o.position;
        const dist = Math.hypot(newPos.x - p.x, newPos.y - p.y);
        const isVehType = o.type === OT.VEHICLE || o.type === OT.TRAFFIC || o.type === OT.CYCLIST;
        // Vehicles: on tactile = grace margin; otherwise standard radius check
        const triggerR = isVehType && onTactileNow
          ? PLAYER_RADIUS + o.radius * 0.55   // tighter trigger while on yellow path
          : PLAYER_RADIUS + o.radius;
        if (dist < triggerR) { hit = o; break; }
      }

      if (hit) {
        const isVehHit = hit.type === OT.VEHICLE || hit.type === OT.TRAFFIC || hit.type === OT.CYCLIST;
        if (LETHAL.includes(hit.type) || isVehHit) {
          try { Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error); } catch (e) {}
          gameStateRef.current = "gameover"; setGameState("gameover");
          setMessage(hit.type === OT.CYCLIST ? "Hit by a cyclist!" : hit.message || "Watch out!");
          try { isVehHit ? playCrash(getAudio()) : playWarn(getAudio()); } catch (e) {}
        } else if (hit.type === OT.PEDESTRIAN_GOOD) {
          safeMsg("A kind stranger points the way!");
          const near = level.pathTiles.reduce((b: any, t: any) =>
            Math.hypot(newX - t.x, newY - t.y) < Math.hypot(newX - b.x, newY - b.y) ? t : b, level.pathTiles[0]);
          newX += (near.x - newX) * 0.15; newY += (near.y - newY) * 0.15;
        } else {
          // ── Axis-separated collision response ────────────────────────────
          // Instead of freezing the player completely (old: newX=prev.x, newY=prev.y),
          // try each axis independently. This lets the player:
          //   • Slide along a wall / pedestrian's side
          //   • Back away from a blocked direction
          //   • Turn and walk around obstacles
          const tryX = { x: newX, y: prev.position.y };
          const tryY = { x: prev.position.x, y: newY };
          const hitX = collide(tryX, PLAYER_RADIUS, [...level.staticObstacles, ...movingActive]);
          const hitY = collide(tryY, PLAYER_RADIUS, [...level.staticObstacles, ...movingActive]);
          if (!hitX) {
            // Can slide along Y axis — keep newX, revert newY
            newY = prev.position.y;
          } else if (!hitY) {
            // Can slide along X axis — keep newY, revert newX
            newX = prev.position.x;
          } else {
            // Fully blocked — revert position but allow rotation
            newX = prev.position.x; newY = prev.position.y;
            // NPC steps aside: nudge the blocking soft obstacle away so player can escape.
            // Without this, the player can get permanently trapped by a patrolling pedestrian.
            const blocker = movingObsRef.current.find((o: any) => {
              const p = o.pos || o.position;
              return (o.type === OT.PEDESTRIAN_BAD || o.type === OT.ANIMAL) &&
                     Math.hypot(newX - p.x, newY - p.y) < PLAYER_RADIUS + o.radius + 4;
            });
            if (blocker) {
              // Push blocker 20 units in the direction it was already moving
              const pushDist = 20;
              if (blocker.axis === "y") blocker.pos.y += (blocker.pedDir || 1) * pushDist;
              else                      blocker.pos.x += (blocker.pedDir || 1) * pushDist;
              // Pause it briefly so player can walk past
              blocker.pedPaused = true; blocker.pedTimer = 0;
            }
          }
          if (now - timers.current.warn > 1500) {
            safeMsg(hit.message || "Watch out!");
            timers.current.warn = now;
            try {
              if (hit.type === OT.ANIMAL) {
                playDog(getAudio());
                // Dog bite — big confidence hit but not instant death
                confidenceRef.current = Math.max(0, confidenceRef.current - 22);
              }
              else if (hit.type === OT.HAWKER || hit.type === OT.CONSTRUCTION) playConstruction(getAudio());
              else playHawker(getAudio());
            } catch (e) {}
          }
        }
      }

      playerStateRef.current = { position: { x: newX, y: newY }, rotation: newRot, pitch: newPitch };
      playerGroup.position.set(newX, 0, newY);
      playerGroup.rotation.y = -newRot;
      const headH = 46;
      camera.position.set(newX + Math.cos(newRot) * 2, headH, newY + Math.sin(newRot) * 2);
      camera.lookAt(newX + Math.cos(newRot) * 100, headH - 14 - Math.tan(newPitch) * 100, newY + Math.sin(newRot) * 100);
      bodyLight.position.set(newX, 38, newY);
      hazeLight.position.set(newX + Math.cos(newRot) * 90, 32, newY + Math.sin(newRot) * 90);

      // Update walking animations (only for non-paused obstacles)
      movingMixers.forEach(mixer => mixer.update(delta));
      renderer.render(scene, camera);
      gl.endFrameEXP();
    };

    animate();
    return () => { running = false; };
  }, [level, distToPath, collide, getAudio, initMoving]);

  const restart = useCallback(() => {
    playerStateRef.current = { position: { ...level.startPos }, rotation: -Math.PI / 2, pitch: 0 };
    confidenceRef.current = MAX_CONFIDENCE;
    gameStateRef.current = "playing";
    setGameState("playing"); setConfidence(MAX_CONFIDENCE); setMessage(null);
    initMoving();
  }, [level, initMoving]);

  const confPct = Math.round((confidence / MAX_CONFIDENCE) * 100);
  const confColor = confPct > 60 ? "#22c55e" : confPct > 30 ? "#eab308" : "#ef4444";

  return (
    <View style={S.container}>
      <GLView style={StyleSheet.absoluteFill} onContextCreate={onContextCreate} />

      <View style={S.hud}>
        <View>
          <Text style={S.lvlName}>{level.name}</Text>
          <Text style={[S.pathTxt, { color: onPath ? "#22c55e" : "#ef4444" }]}>
            {onPath ? "● ON PATH" : "○ OFF PATH"}
          </Text>
        </View>
        <View style={S.hudR}>
          <Text style={S.hudLbl}>Confidence</Text>
          <View style={S.confBar}>
            <View style={[S.confFill, { width: `${confPct}%` as any, backgroundColor: confColor }]} />
          </View>
        </View>
      </View>

      {message && gameState === "playing" && (
        <View style={S.toast}><Text style={S.toastTxt}>⚠ {message}</Text></View>
      )}

      <DualJoystick
        onMoveLeft={d  => { moveInputRef.current  = d; }}
        onEndLeft={()  => { moveInputRef.current  = { x: 0, y: 0 }; }}
        onMoveRight={d => { stickInputRef.current = d; }}
        onEndRight={() => { stickInputRef.current = { x: 0, y: 0 }; }}
      />

      {gameState === "gameover" && (
        <View style={S.overlay}>
          <Text style={S.ovTitle}>Mission <Text style={{ color: "#ef4444" }}>Failed</Text></Text>
          <Text style={S.ovMsg}>{message || "You were lost in the noise of the street."}</Text>
          <Text style={S.btnP} onPress={restart}>↺ RETRY</Text>
          <Text style={S.btnS} onPress={onExit}>← MAIN MENU</Text>
        </View>
      )}

      {gameState === "complete" && (
        <View style={S.overlay}>
          <Text style={S.ovTitle}>Mission <Text style={{ color: "#22c55e" }}>Complete</Text></Text>
          <Text style={S.ovMsg}>{level.destination}</Text>
          {levelIndex < LEVELS.length - 1
            ? <Text style={S.btnP} onPress={() => onLevelComplete(levelIndex + 1)}>▶ NEXT LEVEL</Text>
            : <Text style={S.btnP} onPress={onExit}>⌂ MAIN MENU</Text>}
          <Text style={S.btnS} onPress={onExit}>← MAIN MENU</Text>
        </View>
      )}
    </View>
  );
}

const S = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#000" },
  hud:       { position: "absolute", top: 12, left: 12, right: 12, flexDirection: "row", justifyContent: "space-between", zIndex: 10 },
  lvlName:   { fontSize: 10, color: "#eab308", fontWeight: "900", letterSpacing: 2, textTransform: "uppercase" },
  pathTxt:   { fontSize: 8, letterSpacing: 2, textTransform: "uppercase" },
  hudR:      { alignItems: "flex-end", gap: 4 },
  hudLbl:    { fontSize: 8, color: "rgba(255,255,255,0.4)", letterSpacing: 2, textTransform: "uppercase" },
  confBar:   { width: 100, height: 5, backgroundColor: "rgba(255,255,255,0.1)", borderRadius: 3, overflow: "hidden" },
  confFill:  { height: "100%", borderRadius: 3 },
  toast:     { position: "absolute", top: "34%", alignSelf: "center", backgroundColor: "#eab308", paddingHorizontal: 20, paddingVertical: 10, borderRadius: 2, zIndex: 40 },
  toastTxt:  { color: "#000", fontWeight: "900", fontSize: 11, letterSpacing: 2, textTransform: "uppercase" },
  // sticks: now handled by DualJoystick component
  overlay:   { ...StyleSheet.absoluteFillObject, backgroundColor: "rgba(0,0,0,0.97)", alignItems: "center", justifyContent: "center", zIndex: 50, padding: 24, gap: 12 },
  ovTitle:   { fontSize: 36, fontWeight: "900", color: "#fff", textTransform: "uppercase" },
  ovMsg:     { fontSize: 13, color: "rgba(255,255,255,0.45)", textAlign: "center", maxWidth: 280 },
  btnP:      { backgroundColor: "#eab308", color: "#000", fontWeight: "900", fontSize: 12, letterSpacing: 4, textTransform: "uppercase", paddingVertical: 14, paddingHorizontal: 28, borderRadius: 2, overflow: "hidden" },
  btnS:      { color: "rgba(255,255,255,0.35)", fontSize: 10, letterSpacing: 3, textTransform: "uppercase", paddingVertical: 10 },
});
