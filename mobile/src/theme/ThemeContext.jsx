import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Animated, Easing, StyleSheet, View } from "react-native";
import { useReduceMotion } from "../hooks/useReduceMotion";
import { colors as lightColors, darkColors, darkTones, tones as lightTones } from "./tokens";
import { loadThemeMode, saveThemeMode } from "./themePreference";

const THEMES = {
  light: { colors: lightColors, tones: lightTones, isDark: false },
  dark: { colors: darkColors, tones: darkTones, isDark: true }
};

const FADE_IN_MS = 180;
const FADE_OUT_MS = 260;
// If an animation callback never fires (app sent to the background mid-fade, animation interrupted), the
// touch-blocking layer is removed after this long anyway.
const FADE_SAFETY_MS = FADE_IN_MS + FADE_OUT_MS + 1500;
// The saved choice is read from the phone's key store before the first screen is drawn; if that read is
// slow or never answers, give up waiting and show the light-mode default instead of leaving a blank screen.
const LOAD_TIMEOUT_MS = 1500;

const ThemeContext = createContext({ ...THEMES.light, mode: "light", toggleMode: () => false });

// Screens read colours from here instead of importing them, so the theme can change while the app is
// running. A fresh install always starts in light mode, regardless of the phone's own system setting --
// it never follows system light/dark automatically. Once the user taps the toggle, their choice is saved
// and wins on every later launch.
export function ThemeProvider({ children }) {
  const reduceMotion = useReduceMotion();
  const [mode, setMode] = useState("light");
  const [ready, setReady] = useState(false);
  const [fadeColor, setFadeColor] = useState(null);
  const fadeOpacity = useRef(new Animated.Value(0)).current;
  const fadingRef = useRef(false);
  const mountedRef = useRef(true);
  const safetyTimerRef = useRef(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearTimeout(safetyTimerRef.current);
      fadeOpacity.stopAnimation();
    };
  }, [fadeOpacity]);

  useEffect(() => {
    let active = true;
    const timeoutId = setTimeout(() => {
      if (active) setReady(true);
    }, LOAD_TIMEOUT_MS);
    loadThemeMode().then((saved) => {
      if (!active) return;
      if (saved) {
        setMode(saved);
      }
      setReady(true);
    });
    return () => {
      active = false;
      clearTimeout(timeoutId);
    };
  }, []);

  const finishFade = useCallback(() => {
    clearTimeout(safetyTimerRef.current);
    fadeOpacity.setValue(0);
    fadingRef.current = false;
    if (mountedRef.current) setFadeColor(null);
  }, [fadeOpacity]);

  // A colour "gradient" without recolouring every component on every frame: a full-screen layer in the
  // NEW page colour fades in over the old screen, the theme is swapped underneath it, then the layer
  // fades out to reveal the new theme. Both fades run on the native thread, so they stay smooth. With the
  // system "remove animations" setting on, the theme is swapped at once. Returns false when a toggle is
  // already in progress (the tap is ignored).
  const toggleMode = useCallback(() => {
    if (fadingRef.current) return false;
    const nextMode = mode === "dark" ? "light" : "dark";
    saveThemeMode(nextMode);
    if (reduceMotion) {
      setMode(nextMode);
      return true;
    }

    fadingRef.current = true;
    setFadeColor(THEMES[nextMode].colors.page);
    safetyTimerRef.current = setTimeout(() => {
      if (mountedRef.current) setMode(nextMode);
      finishFade();
    }, FADE_SAFETY_MS);
    Animated.timing(fadeOpacity, {
      toValue: 1,
      duration: FADE_IN_MS,
      easing: Easing.out(Easing.quad),
      useNativeDriver: true
    }).start(({ finished }) => {
      if (mountedRef.current) setMode(nextMode);
      if (!finished) {
        finishFade();
        return;
      }
      // Two frames so the new theme has rendered underneath before the layer starts to fade away.
      requestAnimationFrame(() => requestAnimationFrame(() => {
        Animated.timing(fadeOpacity, {
          toValue: 0,
          duration: FADE_OUT_MS,
          easing: Easing.in(Easing.quad),
          useNativeDriver: true
        }).start(finishFade);
      }));
    });
    return true;
  }, [mode, reduceMotion, fadeOpacity, finishFade]);

  const value = useMemo(() => ({ ...THEMES[mode], mode, toggleMode }), [mode, toggleMode]);

  if (!ready) {
    return <View style={[styles.root, { backgroundColor: THEMES[mode].colors.page }]} />;
  }

  return (
    <ThemeContext.Provider value={value}>
      <View style={styles.root}>
        {children}
        {fadeColor ? (
          <Animated.View
            pointerEvents="auto"
            style={[StyleSheet.absoluteFill, { backgroundColor: fadeColor, opacity: fadeOpacity }]}
          />
        ) : null}
      </View>
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeContext);
}

// Screens declare their styles as `makeStyles = (colors, tones) => StyleSheet.create({...})` and call
// `const styles = useThemedStyles(makeStyles)`; the styles are rebuilt only when the theme changes.
// `makeStyles` must be a module-level function (an inline arrow would rebuild the styles every render).
export function useThemedStyles(makeStyles) {
  const { colors, tones } = useTheme();
  return useMemo(() => makeStyles(colors, tones), [makeStyles, colors, tones]);
}

const styles = StyleSheet.create({
  root: {
    flex: 1
  }
});
