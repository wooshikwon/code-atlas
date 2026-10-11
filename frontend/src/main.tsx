import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { useStatus } from "./state/status";
import { useAtlas } from "./state/store";
import "./styles.css";

useAtlas.getState().restore();
useStatus.getState().watch();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
