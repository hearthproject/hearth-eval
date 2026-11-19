import { createRoot } from "react-dom/client";
import { NativeHome } from "./native-home.tsx";
import "./native-main.css";

createRoot(document.getElementById("native-root")!).render(<NativeHome />);
