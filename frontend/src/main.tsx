import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { useOverlay } from "./state/overlay";
import { useAtlas } from "./state/store";
import "./styles.css";

useAtlas.getState().load();
useOverlay.getState().load();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
