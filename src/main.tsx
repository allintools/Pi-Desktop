import React from "react";
import { createRoot } from "react-dom/client";
import { ThemeProvider, ThemeBackground } from "./theme/ThemeProvider";
import { NativeThemeSync } from "./theme/NativeThemeSync";
import App from "./App";
import "./app.css";
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ThemeProvider>
      <ThemeBackground />
      <NativeThemeSync />
      <App />
    </ThemeProvider>
  </React.StrictMode>,
);
