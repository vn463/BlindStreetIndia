// src/components/Joystick.tsx
//
// WHY PREVIOUS APPROACHES FAILED:
//   PanResponder: only one active responder at a time — second joystick always blocked.
//   Responder system (onStartShouldSetResponder etc.): same limitation, one responder wins.
//   onTouchStart/Move/End on separate Views: React Native still routes touches through
//   the responder system, so only one View gets move events at a time.
//
// SOLUTION: Single parent View covering the entire controls area handles ALL touches.
//   Touch position determines left joystick (left half) vs right joystick (right half).
//   Both knobs are rendered inside with pointerEvents='none' so no child steals events.
//   One responder, two logical joysticks — true simultaneous multi-touch.

import React, { useRef, useState } from 'react';
import { View, Text, StyleSheet, Dimensions } from 'react-native';

interface DualJoystickProps {
  onMoveLeft:  (dir: { x: number; y: number }) => void;
  onEndLeft:   () => void;
  onMoveRight: (dir: { x: number; y: number }) => void;
  onEndRight:  () => void;
}

const STICK_SIZE = 100;
const KNOB_SIZE  = 42;
const MAX_DIST   = (STICK_SIZE - KNOB_SIZE) / 2;

export default function DualJoystick({
  onMoveLeft, onEndLeft, onMoveRight, onEndRight,
}: DualJoystickProps) {
  const [leftKnob,  setLeftKnob]  = useState({ x: 0, y: 0 });
  const [rightKnob, setRightKnob] = useState({ x: 0, y: 0 });

  const leftTouch  = useRef<{ id: number; ox: number; oy: number } | null>(null);
  const rightTouch = useRef<{ id: number; ox: number; oy: number } | null>(null);

  const screenW = Dimensions.get('window').width;

  function clamp(dx: number, dy: number) {
    const dist    = Math.sqrt(dx * dx + dy * dy);
    const clamped = Math.min(dist, MAX_DIST);
    const angle   = Math.atan2(dy, dx);
    return {
      cx: Math.cos(angle) * clamped,
      cy: Math.sin(angle) * clamped,
      nx: Math.cos(angle) * (dist > 0 ? clamped / MAX_DIST : 0),
      ny: Math.sin(angle) * (dist > 0 ? clamped / MAX_DIST : 0),
    };
  }

  return (
    <View
      style={S.container}
      // Single responder for the entire controls area
      onStartShouldSetResponder={() => true}
      onMoveShouldSetResponder={() => true}
      onStartShouldSetResponderCapture={() => false}
      onMoveShouldSetResponderCapture={() => false}

      onResponderGrant={(e) => {
        const touches = e.nativeEvent.changedTouches;
        for (let i = 0; i < touches.length; i++) {
          const t = touches[i];
          if (t.pageX < screenW / 2) {
            if (!leftTouch.current) {
              leftTouch.current = { id: t.identifier, ox: t.pageX, oy: t.pageY };
            }
          } else {
            if (!rightTouch.current) {
              rightTouch.current = { id: t.identifier, ox: t.pageX, oy: t.pageY };
            }
          }
        }
      }}

      onResponderMove={(e) => {
        const touches = e.nativeEvent.touches;
        for (let i = 0; i < touches.length; i++) {
          const t = touches[i];
          if (leftTouch.current && t.identifier === leftTouch.current.id) {
            const { cx, cy, nx, ny } = clamp(
              t.pageX - leftTouch.current.ox,
              t.pageY - leftTouch.current.oy
            );
            setLeftKnob({ x: cx, y: cy });
            onMoveLeft({ x: nx, y: ny });
          }
          if (rightTouch.current && t.identifier === rightTouch.current.id) {
            const { cx, cy, nx, ny } = clamp(
              t.pageX - rightTouch.current.ox,
              t.pageY - rightTouch.current.oy
            );
            setRightKnob({ x: cx, y: cy });
            onMoveRight({ x: nx, y: ny });
          }
        }
      }}

      onResponderRelease={(e) => {
        const touches = e.nativeEvent.changedTouches;
        for (let i = 0; i < touches.length; i++) {
          const t = touches[i];
          if (leftTouch.current && t.identifier === leftTouch.current.id) {
            leftTouch.current = null;
            setLeftKnob({ x: 0, y: 0 });
            onEndLeft();
          }
          if (rightTouch.current && t.identifier === rightTouch.current.id) {
            rightTouch.current = null;
            setRightKnob({ x: 0, y: 0 });
            onEndRight();
          }
        }
      }}

      onResponderTerminate={() => {
        leftTouch.current  = null;
        rightTouch.current = null;
        setLeftKnob({ x: 0, y: 0 });
        setRightKnob({ x: 0, y: 0 });
        onEndLeft();
        onEndRight();
      }}
    >
      {/* Left joystick — pointerEvents none so parent gets all touches */}
      <View style={S.stick} pointerEvents="none">
        <View style={S.base}>
          <View style={[S.knob, { transform: [{ translateX: leftKnob.x }, { translateY: leftKnob.y }] }]} />
        </View>
        <Text style={S.label}>MOVE</Text>
      </View>

      {/* Right joystick */}
      <View style={S.stick} pointerEvents="none">
        <View style={S.base}>
          <View style={[S.knob, { transform: [{ translateX: rightKnob.x }, { translateY: rightKnob.y }] }]} />
        </View>
        <Text style={S.label}>LOOK</Text>
      </View>
    </View>
  );
}

const S = StyleSheet.create({
  container: {
    position: 'absolute',
    bottom: 0, left: 0, right: 0,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-end',
    paddingHorizontal: 24,
    paddingBottom: 24,
    height: 180,   // tall enough to be easily touchable
    zIndex: 20,
  },
  stick:  { alignItems: 'center', gap: 4 },
  base: {
    width: STICK_SIZE, height: STICK_SIZE, borderRadius: STICK_SIZE / 2,
    backgroundColor: 'rgba(255,255,255,0.07)',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)',
    alignItems: 'center', justifyContent: 'center',
  },
  knob: {
    width: KNOB_SIZE, height: KNOB_SIZE, borderRadius: KNOB_SIZE / 2,
    backgroundColor: 'rgba(234,179,8,0.6)',
    borderWidth: 1.5, borderColor: 'rgba(234,179,8,0.95)',
  },
  label: {
    fontSize: 7, color: 'rgba(255,255,255,0.3)',
    letterSpacing: 2, textTransform: 'uppercase',
  },
});
