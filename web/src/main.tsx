import { createRoot } from "react-dom/client";
import { App } from "./App";
import { Landing } from "./Landing";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("Application root was not found");

const path = window.location.pathname;
const page = path === "/app"
  ? <App />
  : path === "/"
    ? <Landing />
    : <main><h1>Page not found</h1><a href="/">Return to Instanta</a></main>;

createRoot(root).render(page);
