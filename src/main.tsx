import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { TrayClockPopover } from "./components/TrayClockPopover";
import "./index.css";

const isTrayPopover = window.location.hash === "#tray";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {isTrayPopover ? <TrayClockPopover /> : <App />}
  </React.StrictMode>
);
