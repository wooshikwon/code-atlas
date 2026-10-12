import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { host } from "./host";
import { useOpening } from "./state/opening";
import { useStatus } from "./state/status";
import { useAtlas } from "./state/store";
import "./styles.css";

useAtlas.getState().restore();
useStatus.getState().watch();
host.onMenu(() => void useOpening.getState().browse());
host.onOpen((paths) => void useOpening.getState().drop(paths));

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
