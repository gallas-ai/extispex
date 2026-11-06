// @ts-types="@types/react-dom/client"
import { createRoot } from "react-dom/client";
import { StrictMode } from "react";
import { App } from "./app.tsx";
import "./styles.css";

const rootElement = document.getElementById("root");
if (rootElement === null) {
  throw new Error("The page is missing the #root element.");
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
