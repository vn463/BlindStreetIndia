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
const MOVE_SPEED        = 1.8;
const ROTATION_SPEED    = 0.045;
const FOG_DENSITY       = 0.018;
const PATH_DRAIN_RATE   = 0.08;
const PATH_RECOVER_RATE = 0.04;
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
const MODEL_CONFIG: Record<string, { key: string; scale: number; yOffset: number }> = {
  [OT.VEHICLE]:         { key: "vehicle",          scale: 45, yOffset: 0  },
  [OT.TRAFFIC]:         { key: "vehicle",           scale: 45, yOffset: 0  },
  [OT.CYCLIST]:         { key: "cyclist",           scale: 28, yOffset: 0  },
  [OT.ANIMAL]:          { key: "animal",            scale: 18, yOffset: 0  },
  [OT.PEDESTRIAN_BAD]:  { key: "pedestrian_bad",    scale: 32, yOffset: 0  },
  [OT.PEDESTRIAN_GOOD]: { key: "pedestrian_guide",  scale: 32, yOffset: 0  },
  [OT.HAWKER]:          { key: "hawker",            scale: 36, yOffset: 0  },
  [OT.CONSTRUCTION]:    { key: "construction",      scale: 28, yOffset: 0  },
  [OT.POTHOLE]:         { key: "pothole",           scale: 22, yOffset: -2 },
  [OT.MANHOLE]:         { key: "manhole",           scale: 22, yOffset: 0  },
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
  } else if (type === OT.PEDESTRIAN_BAD || type === OT.PEDESTRIAN_GOOD) {
    const col = type === OT.PEDESTRIAN_GOOD ? 0x22c55e : 0x8b5cf6;
    const body = new THREE.Mesh(new THREE.BoxGeometry(12, 30, 9),
      new THREE.MeshStandardMaterial({ color: col, emissive: col, emissiveIntensity: 0.4 }));
    body.position.y = 20; g.add(body);
    const head = new THREE.Mesh(new THREE.SphereGeometry(7, 8, 8),
      new THREE.MeshStandardMaterial({ color: 0xc68642, emissive: 0xc68642, emissiveIntensity: 0.3 }));
    head.position.y = 42; g.add(head);
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
    const r = new THREE.Mesh(new THREE.CircleGeometry(radius, 20),
      new THREE.MeshStandardMaterial({ color: 0x1a1a1a, emissive: 0x111111, emissiveIntensity: 0.2 }));
    r.rotation.x = -Math.PI / 2; r.position.y = 0.2; g.add(r);
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
): Promise<THREE.Object3D | null> {

  if (type === OT.TACTILE_PAVING) {
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(radius * 2, 2.8, radius * 2),
      new THREE.MeshStandardMaterial({
        color: new THREE.Color(0.95, 0.72, 0.02), roughness: 0.78,
        emissive: new THREE.Color(0.28, 0.15, 0.0), emissiveIntensity: 1.0,
      })
    );
    mesh.position.set(pos.x, 1.4, pos.y);
    mesh.receiveShadow = true;
    scene.add(mesh);
    return mesh;
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
    return g;
  }

  const config = MODEL_CONFIG[type];
  if (!config) return null;

  let obj: THREE.Object3D;
  const model = await loadModel(config.key); // never throws, returns null on failure
  if (model) {
    model.scale.setScalar(config.scale);
    model.position.set(pos.x, config.yOffset, pos.y);
    model.traverse((c: any) => { if (c.isMesh) { c.castShadow = true; c.receiveShadow = true; } });
    obj = model;
  } else {
    obj = buildFallback(type, radius);
    obj.position.set(pos.x, 0, pos.y);
  }
  scene.add(obj);
  return obj;
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
    const road = new THREE.Mesh(new THREE.PlaneGeometry(900, 1200),
      new THREE.MeshStandardMaterial({ color: 0x3a3a3a, roughness: 0.9 }));
    road.rotation.x = -Math.PI / 2; road.position.set(450, -0.5, 500);
    road.receiveShadow = true; scene.add(road);

    const paveMat = new THREE.MeshStandardMaterial({ color: 0xb0a090, roughness: 0.85 });
    for (const lx of [210, 690]) {
      const pave = new THREE.Mesh(new THREE.BoxGeometry(80, 3, 1200), paveMat);
      pave.position.set(lx, 1.5, 500); pave.receiveShadow = true; scene.add(pave);
    }

    for (const b of [
      { x: 160, zStart: -50,  w: 160, d: 160, h: 220, color: 0xd4b896 },
      { x: 140, zStart: 160,  w: 140, d: 140, h: 300, color: 0xb8956a },
      { x: 170, zStart: 360,  w: 180, d: 150, h: 180, color: 0xe8d5b0 },
      { x: 150, zStart: 570,  w: 160, d: 140, h: 280, color: 0xc4a882 },
      { x: 740, zStart: -50,  w: 160, d: 160, h: 240, color: 0xb8c4b0 },
      { x: 760, zStart: 160,  w: 140, d: 140, h: 320, color: 0xc8b090 },
      { x: 750, zStart: 360,  w: 160, d: 150, h: 190, color: 0xd8c8a8 },
      { x: 740, zStart: 570,  w: 150, d: 140, h: 360, color: 0xa09888 },
    ]) {
      const bMesh = new THREE.Mesh(new THREE.BoxGeometry(b.w, b.h, b.d),
        new THREE.MeshStandardMaterial({ color: new THREE.Color(b.color).multiplyScalar(0.78), roughness: 0.88 }));
      bMesh.position.set(b.x, b.h / 2, b.zStart + b.d / 2);
      bMesh.castShadow = true; bMesh.receiveShadow = true; scene.add(bMesh);
    }

    // Procedural street lamps (skip GLTF for lamps to save memory)
    const poleMat = new THREE.MeshStandardMaterial({ color: 0x2a2a2a, metalness: 0.7 });
    for (let z = 50; z < 950; z += 200) {
      for (const lx of [248, 652]) {
        const pole = new THREE.Mesh(new THREE.CylinderGeometry(2.5, 3, 140, 6), poleMat);
        pole.position.set(lx, 70, z); scene.add(pole);
        const light = new THREE.PointLight(0xfff0a0, 2.0, 500);
        light.position.set(lx, 128, z); scene.add(light);
      }
    }

    // ── Game objects ────────────────────────────────────────────────────────
    await Promise.all(level.pathTiles.map((t: any) => buildMesh(scene, OT.TACTILE_PAVING, t, 16)));
    await Promise.all(level.staticObstacles.map((o: any) => buildMesh(scene, o.type, o.position, o.radius)));
    await buildMesh(scene, OT.DESTINATION, level.destinationPos, 42);

    const destLight = new THREE.PointLight(0x22c55e, 2.0, 220);
    destLight.position.set(level.destinationPos.x, 30, level.destinationPos.y);
    scene.add(destLight);

    const movingMeshes: Record<string, THREE.Object3D | null> = {};
    await Promise.all(movingObsRef.current.map(async (o: any) => {
      movingMeshes[o.id] = await buildMesh(scene, o.type, o.pos, o.radius);
    }));

    const playerGroup = new THREE.Group();
    scene.add(playerGroup);

    // ── Game loop ────────────────────────────────────────────────────────────
    const LETHAL = [OT.ANIMAL, OT.MANHOLE, OT.POTHOLE, OT.TRAFFIC, OT.CYCLIST];
    let msgT: any = null;
    const safeMsg = (txt: string, dur = 2200) => {
      if (msgT) clearTimeout(msgT);
      setMessage(txt);
      msgT = setTimeout(() => setMessage(null), dur);
    };

    let running = true;
    let lastTime = performance.now();

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
            m.position.x = o.pos.x; m.position.z = o.pos.y;
            m.rotation.y = o.axis === "y" ? (o.dir > 0 ? -Math.PI/2 : Math.PI/2) : (o.dir > 0 ? 0 : Math.PI);
          }
        } else if (isPed) {
          if (!o.pedDir) o.pedDir = 1;
          o.pedTimer += delta;
          const ref = o.spawnPos || { x: o.pos.x, y: o.pos.y };
          if (o.pedPaused) {
            if (o.pedTimer > 1.0) { o.pedPaused = false; o.pedDir *= -1; o.pedTimer = 0; }
          } else {
            const spd = o.speed * 0.9 * fs;
            o.axis === "y" ? (o.pos.y += o.pedDir * spd) : (o.pos.x += o.pedDir * spd);
            const half = (o.range || 80) / 2;
            if (o.axis === "y" ? Math.abs(o.pos.y - ref.y) > half : Math.abs(o.pos.x - ref.x) > half) {
              o.pedPaused = true; o.pedTimer = 0;
            }
          }
          if (m) {
            m.position.x = o.pos.x; m.position.z = o.pos.y;
            const dx = o.pos.x - prevX, dz = o.pos.y - prevY;
            if (Math.abs(dx) > 0.001 || Math.abs(dz) > 0.001) m.rotation.y = -Math.atan2(dz, dx);
          }
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
            if (Math.abs(dx) > 0.001 || Math.abs(dz) > 0.001) m.rotation.y = -Math.atan2(dz, dx);
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

      for (const o of movingObsRef.current) {
        if (o.waiting || !(o.type === OT.VEHICLE || o.type === OT.TRAFFIC || o.type === OT.CYCLIST)) continue;
        const dist = Math.hypot(newPos.x - o.pos.x, newPos.y - o.pos.y);
        if (dist > 150 || dist <= o.radius + PLAYER_RADIUS) continue;
        const dot = (o.pos.x - newPos.x) * Math.cos(newRot) + (o.pos.y - newPos.y) * Math.sin(newRot);
        if (Math.abs(newPos.y - o.pos.y) < o.radius + 50 && dot > -20) {
          const urgent = dist < 65;
          if (now - timers.current.honk > (urgent ? 600 : 1100)) {
            try { urgent ? playBeepBeepUrgent(getAudio()) : playBeepBeep(getAudio()); } catch (e) {}
            timers.current.honk = now;
          }
        }
      }

      const hit = collide(newPos, PLAYER_RADIUS, level.staticObstacles) ||
                  collide(newPos, PLAYER_RADIUS, movingObsRef.current.filter((o: any) => !o.waiting));
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
          newX = prev.position.x; newY = prev.position.y;
          if (now - timers.current.warn > 1500) {
            safeMsg(hit.message || "Watch out!");
            timers.current.warn = now;
            try {
              if (hit.type === OT.ANIMAL) playDog(getAudio());
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
