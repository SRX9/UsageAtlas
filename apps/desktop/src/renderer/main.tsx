import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/inter";
import "./globals.css";
import { App } from "./App";

// Keep the component and glass themes aligned with the OS appearance.
const systemDark = matchMedia("(prefers-color-scheme: dark)");

function applySystemTheme(): void {
  const dark = systemDark.matches;
  const rootElement = document.documentElement;
  rootElement.classList.toggle("dark", dark);
  rootElement.classList.toggle("glass-dark", dark);
  rootElement.classList.toggle("light", !dark);
  rootElement.classList.toggle("glass-light", !dark);
  rootElement.dataset.theme = dark ? "glass-dark" : "glass-light";
}

applySystemTheme();
systemDark.addEventListener("change", applySystemTheme);

const root = document.getElementById("root");
if (!root) throw new Error("Missing renderer root");
createRoot(root).render(<StrictMode><App /></StrictMode>);
