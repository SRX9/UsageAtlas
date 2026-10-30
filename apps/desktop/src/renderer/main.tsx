import { Toast } from "@heroui/react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/inter";
import "@fontsource-variable/manrope";
import "@fontsource-variable/figtree";
import "@fontsource-variable/plus-jakarta-sans";
import "@fontsource-variable/geist";
import "@fontsource-variable/outfit";
import "@fontsource-variable/sora";
import "@fontsource-variable/newsreader";
import "@fontsource-variable/fraunces";
import "./globals.css";
import { App } from "./App";
import { CompactWidget } from "./CompactWidget";
import { applyTheme } from "./appearance";

// Paint the OS palette before preferences load; applyAppearance replaces it with
// the user's choice (System, Light or Dark) as soon as they are available.
applyTheme("system");

// A window hidden in the tray or minimized still paints its gradients, sweeps
// and shimmer while the compositor keeps the page alive. Marking the document
// lets the stylesheet park every animation until it is back on screen.
function applyWindowVisibility(): void {
  document.documentElement.dataset.windowHidden = document.visibilityState === "visible" ? "false" : "true";
}

applyWindowVisibility();
document.addEventListener("visibilitychange", applyWindowVisibility);

const root = document.getElementById("root");
if (!root) throw new Error("Missing renderer root");
const widgetMode = location.hash.replace(/^#/, "") === "widget";
if (widgetMode) {
  document.documentElement.dataset.surface = "widget";
  createRoot(root).render(<StrictMode><CompactWidget /></StrictMode>);
} else {
  // Toasts sit outside the shell, whose glass panels would otherwise anchor them.
  createRoot(root).render(<StrictMode><App /><Toast.Provider placement="bottom end" /></StrictMode>);
}
