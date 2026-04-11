// src/components/Joystick.tsx
import React, { useRef, useState } from "react";
import { View, Text, PanResponder, StyleSheet } from "react-native";

interface JoystickProps {
  label: string;
  onMove: (dir: { x: number; y: number }) => void;
  onEnd: () => void;
}

const STICK_SIZE = 90;
const KNOB_SIZE  = 38;
const MAX_DIST   = (STICK_SIZE - KNOB_SIZE) / 2;

export default function Joystick({ label, onMove, onEnd }: JoystickProps) {
  const [knob, setKnob]  = useState({ x: 0, y: 0 });
  const startPos = useRef({ x: 0, y: 0 });
  const active   = useRef(false);

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder:  () => true,

      onPanResponderGrant: (evt) => {
        active.current = true;
        startPos.current = { x: evt.nativeEvent.pageX, y: evt.nativeEvent.pageY };
      },

      onPanResponderMove: (evt) => {
        if (!active.current) return;
        const dx = evt.nativeEvent.pageX - startPos.current.x;
        const dy = evt.nativeEvent.pageY - startPos.current.y;
        const dist    = Math.sqrt(dx * dx + dy * dy);
        const clamped = Math.min(dist, MAX_DIST);
        const angle   = Math.atan2(dy, dx);
        const cx = Math.cos(angle) * clamped;
        const cy = Math.sin(angle) * clamped;
        setKnob({ x: cx, y: cy });
        onMove({ x: cx / MAX_DIST, y: cy / MAX_DIST });
      },

      onPanResponderRelease: () => {
        active.current = false;
        setKnob({ x: 0, y: 0 });
        onEnd();
      },

      onPanResponderTerminate: () => {
        active.current = false;
        setKnob({ x: 0, y: 0 });
        onEnd();
      },
    })
  ).current;

  return (
    <View style={S.container} {...panResponder.panHandlers}>
      <View style={S.base}>
        <View style={[S.knob, { transform: [{ translateX: knob.x }, { translateY: knob.y }] }]} />
      </View>
      <Text style={S.label}>{label}</Text>
    </View>
  );
}

const S = StyleSheet.create({
  container: { alignItems: "center", gap: 4 },
  base: {
    width: STICK_SIZE, height: STICK_SIZE, borderRadius: STICK_SIZE / 2,
    backgroundColor: "rgba(255,255,255,0.07)",
    borderWidth: 1, borderColor: "rgba(255,255,255,0.15)",
    alignItems: "center", justifyContent: "center",
  },
  knob: {
    width: KNOB_SIZE, height: KNOB_SIZE, borderRadius: KNOB_SIZE / 2,
    backgroundColor: "rgba(234,179,8,0.55)",
    borderWidth: 1.5, borderColor: "rgba(234,179,8,0.9)",
  },
  label: { fontSize: 7, color: "rgba(255,255,255,0.25)", letterSpacing: 2, textTransform: "uppercase" },
});
