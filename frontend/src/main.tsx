import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { AtlasProvider } from "./state/AtlasProvider";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AtlasProvider>
      <App />
    </AtlasProvider>
  </StrictMode>,
);
