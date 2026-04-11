// app/index.tsx  — Expo Router entry point
import React, { useState, useEffect, useCallback } from "react";
import {
  View, Text, StyleSheet, ScrollView,
  TouchableOpacity, ActivityIndicator,
} from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import Game from "../src/components/Game";
import { preloadAllModels } from "../src/utils/ModelCache";
import { LEVELS } from "../src/utils/levels";

type Screen = "loading" | "menu" | "game";

export default function Root() {
  const [screen, setScreen]             = useState<Screen>("loading");
  const [levelIndex, setLevelIndex]     = useState(0);
  const [unlockedUpTo, setUnlockedUpTo] = useState(0);
  const [loadProgress, setLoadProgress] = useState({ loaded: 0, total: 13 });
  const [loadError, setLoadError]       = useState<string | null>(null);

  const preload = useCallback(async () => {
    setLoadError(null);
    try {
      await preloadAllModels((loaded, total) => {
        setLoadProgress({ loaded, total });
      });
      setScreen("menu");
    } catch (err: any) {
      setLoadError(err?.message || "Failed to download models. Check your connection.");
    }
  }, []);

  useEffect(() => { preload(); }, [preload]);

  if (screen === "loading") {
    const pct = Math.round((loadProgress.loaded / loadProgress.total) * 100);
    return (
      <View style={splash.container}>
        <Text style={splash.title}>
          Blind{"\n"}<Text style={splash.accent}>Street</Text>
        </Text>
        <Text style={splash.sub}>INDIA · v2.0</Text>
        <View style={splash.barContainer}>
          <View style={[splash.bar, { width: `${pct}%` as any }]} />
        </View>
        {loadError ? (
          <>
            <Text style={splash.error}>⚠ {loadError}</Text>
            <Text style={splash.retry} onPress={preload}>TAP TO RETRY</Text>
          </>
        ) : (
          <>
            <Text style={splash.progress}>
              {loadProgress.loaded < loadProgress.total
                ? `Downloading models… ${loadProgress.loaded}/${loadProgress.total}`
                : "Ready!"}
            </Text>
            <ActivityIndicator color="#eab308" style={{ marginTop: 12 }} />
            <Text style={splash.hint}>
              First launch downloads 3D models.{"\n"}Future launches are instant.
            </Text>
          </>
        )}
      </View>
    );
  }

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      {screen === "menu" ? (
        <MenuScreen
          onStart={(i) => {
            if (i <= unlockedUpTo) { setLevelIndex(i); setScreen("game"); }
          }}
          unlockedUpTo={unlockedUpTo}
        />
      ) : (
        <Game
          key={levelIndex}
          levelIndex={levelIndex}
          onExit={() => setScreen("menu")}
          onLevelComplete={(nextIndex) => {
            setUnlockedUpTo((prev) => Math.max(prev, nextIndex));
            setLevelIndex(nextIndex);
          }}
        />
      )}
    </GestureHandlerRootView>
  );
}

// ── Menu ───────────────────────────────────────────────────────────────────────
function MenuScreen({
  onStart,
  unlockedUpTo,
}: {
  onStart: (i: number) => void;
  unlockedUpTo: number;
}) {
  const [sel, setSel] = useState(0);
  const progressPct = Math.round((unlockedUpTo / LEVELS.length) * 100);

  return (
    <View style={menu.container}>
      <View style={menu.header}>
        <Text style={menu.eyebrow}>Empathy · Awareness · Navigation</Text>
        <Text style={menu.title}>
          Blind{"\n"}<Text style={menu.accent}>Street</Text>
        </Text>
        <Text style={menu.version}>INDIA · v2.0</Text>
      </View>

      <View style={menu.progressSection}>
        <View style={menu.progressRow}>
          <Text style={menu.progressLabel}>Progress</Text>
          <Text style={menu.progressCount}>{unlockedUpTo}/{LEVELS.length} complete</Text>
        </View>
        <View style={menu.progressBar}>
          <View style={[menu.progressFill, { width: `${progressPct}%` as any }]} />
        </View>
      </View>

      <ScrollView style={menu.list} showsVerticalScrollIndicator={false}>
        {LEVELS.map((lvl: any, i: number) => {
          const locked     = i > unlockedUpTo;
          const completed  = i < unlockedUpTo;
          const isSelected = sel === i && !locked;
          return (
            <TouchableOpacity
              key={lvl.id}
              onPress={() => { if (!locked) setSel(i); }}
              style={[
                menu.levelRow,
                isSelected && menu.levelRowSelected,
                completed  && menu.levelRowDone,
                locked     && menu.levelRowLocked,
              ]}
              activeOpacity={locked ? 1 : 0.7}
            >
              <View style={[
                menu.badge,
                isSelected && menu.badgeSelected,
                completed  && menu.badgeDone,
                locked     && menu.badgeLocked,
              ]}>
                <Text style={[menu.badgeText, {
                  color: locked ? "rgba(255,255,255,0.3)"
                    : completed  ? "#4ade80"
                    : isSelected ? "#eab308"
                    : "rgba(255,255,255,0.6)",
                }]}>
                  {locked ? "🔒" : completed ? "✓" : lvl.id}
                </Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={[menu.levelName, {
                  color: locked ? "rgba(255,255,255,0.3)"
                    : isSelected ? "#eab308"
                    : completed  ? "#86efac"
                    : "#e0e0e0",
                }]}>{lvl.name}</Text>
                <Text style={[menu.levelDest, {
                  color: locked ? "rgba(255,255,255,0.18)" : "rgba(255,255,255,0.35)",
                }]}>
                  {locked ? "Complete previous level to unlock" : lvl.destination}
                </Text>
              </View>
              <Text style={[menu.statusBadge, {
                color: locked ? "rgba(255,255,255,0.2)"
                  : completed      ? "#4ade80"
                  : i === unlockedUpTo ? "#eab308"
                  : "rgba(255,255,255,0.3)",
              }]}>
                {locked ? "LOCKED" : completed ? "DONE" : i === unlockedUpTo ? "PLAY" : ""}
              </Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>

      <View style={menu.startSection}>
        <TouchableOpacity
          style={[menu.startBtn, sel > unlockedUpTo && menu.startBtnDisabled]}
          onPress={() => { if (sel <= unlockedUpTo) onStart(sel); }}
          activeOpacity={sel <= unlockedUpTo ? 0.8 : 1}
        >
          <Text style={[menu.startText, sel > unlockedUpTo && menu.startTextDisabled]}>
            {sel <= unlockedUpTo
              ? `▶ Start — ${LEVELS[sel].name}`
              : "🔒 Select an unlocked level"}
          </Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────────────
const splash = StyleSheet.create({
  container:    { flex: 1, backgroundColor: "#0c0c0e", alignItems: "center", justifyContent: "center", padding: 32 },
  title:        { fontSize: 52, fontWeight: "900", color: "#fff", textAlign: "center", lineHeight: 50, letterSpacing: -1, textTransform: "uppercase", marginBottom: 8 },
  accent:       { color: "#eab308" },
  sub:          { fontSize: 10, color: "rgba(255,255,255,0.25)", letterSpacing: 4, marginBottom: 40 },
  barContainer: { width: "100%", maxWidth: 320, height: 4, backgroundColor: "rgba(255,255,255,0.08)", borderRadius: 2, overflow: "hidden", marginBottom: 16 },
  bar:          { height: "100%", backgroundColor: "#eab308", borderRadius: 2 },
  progress:     { fontSize: 11, color: "rgba(255,255,255,0.5)", letterSpacing: 1, textTransform: "uppercase" },
  error:        { fontSize: 12, color: "#ef4444", textAlign: "center", marginBottom: 16 },
  retry:        { fontSize: 11, color: "#eab308", letterSpacing: 3, textTransform: "uppercase", textDecorationLine: "underline" },
  hint:         { fontSize: 9, color: "rgba(255,255,255,0.2)", textAlign: "center", marginTop: 24, lineHeight: 16 },
});

const menu = StyleSheet.create({
  container:        { flex: 1, backgroundColor: "#0c0c0e" },
  header:           { alignItems: "center", paddingTop: 40, paddingBottom: 20, backgroundColor: "#111118" },
  eyebrow:          { fontSize: 9, color: "#eab308", letterSpacing: 5, textTransform: "uppercase", marginBottom: 12 },
  title:            { fontSize: 52, fontWeight: "900", color: "#fff", textAlign: "center", lineHeight: 50, letterSpacing: -1, textTransform: "uppercase", marginBottom: 10 },
  accent:           { color: "#eab308" },
  version:          { fontSize: 10, color: "rgba(255,255,255,0.25)", letterSpacing: 4 },
  progressSection:  { paddingHorizontal: 20, paddingVertical: 16 },
  progressRow:      { flexDirection: "row", justifyContent: "space-between", marginBottom: 8 },
  progressLabel:    { fontSize: 9, color: "rgba(255,255,255,0.35)", letterSpacing: 2, textTransform: "uppercase" },
  progressCount:    { fontSize: 9, color: "#eab308", letterSpacing: 1 },
  progressBar:      { height: 5, backgroundColor: "rgba(255,255,255,0.08)", borderRadius: 3, overflow: "hidden" },
  progressFill:     { height: "100%", backgroundColor: "#eab308", borderRadius: 3 },
  list:             { flex: 1, paddingHorizontal: 20 },
  levelRow:         { flexDirection: "row", alignItems: "center", gap: 12, padding: 13, marginBottom: 6, backgroundColor: "rgba(255,255,255,0.04)", borderWidth: 1, borderColor: "rgba(255,255,255,0.1)", borderRadius: 5 },
  levelRowSelected: { backgroundColor: "rgba(234,179,8,0.10)", borderColor: "rgba(234,179,8,0.55)" },
  levelRowDone:     { backgroundColor: "rgba(34,197,94,0.06)", borderColor: "rgba(34,197,94,0.25)" },
  levelRowLocked:   { backgroundColor: "#111115", borderColor: "rgba(255,255,255,0.06)" },
  badge:            { width: 34, height: 34, borderRadius: 4, backgroundColor: "rgba(255,255,255,0.08)", borderWidth: 1, borderColor: "rgba(255,255,255,0.12)", alignItems: "center", justifyContent: "center" },
  badgeSelected:    { backgroundColor: "rgba(234,179,8,0.22)", borderColor: "rgba(234,179,8,0.4)" },
  badgeDone:        { backgroundColor: "rgba(34,197,94,0.18)", borderColor: "rgba(34,197,94,0.3)" },
  badgeLocked:      { backgroundColor: "rgba(255,255,255,0.05)", borderColor: "rgba(255,255,255,0.08)" },
  badgeText:        { fontSize: 11, fontWeight: "900" },
  levelName:        { fontSize: 11, fontWeight: "700", letterSpacing: 1, textTransform: "uppercase" },
  levelDest:        { fontSize: 8, marginTop: 2, letterSpacing: 1, textTransform: "uppercase" },
  statusBadge:      { fontSize: 8, fontWeight: "700", letterSpacing: 1, textTransform: "uppercase" },
  startSection:     { padding: 20 },
  startBtn:         { backgroundColor: "#eab308", padding: 16, borderRadius: 5, alignItems: "center" },
  startBtnDisabled: { backgroundColor: "rgba(255,255,255,0.06)" },
  startText:        { color: "#000", fontWeight: "900", fontSize: 12, letterSpacing: 4, textTransform: "uppercase" },
  startTextDisabled:{ color: "rgba(255,255,255,0.25)" },
});
