import { Children, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, ArrowRight, ChevronRight } from "lucide-react";

export function ScrambleTitle({ text, id, as: Tag = "h2" }: { text: string; id?: string; as?: "h1" | "h2" }) {
  const [display, setDisplay] = useState(text);
  const frame = useRef(0);
  const heading = useRef<HTMLHeadingElement>(null);
  function play() {
    cancelAnimationFrame(frame.current);
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) { setDisplay(text); return; }
    const start = performance.now();
    const glyphs = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789◇+/<>{}";
    function tick(now: number) {
      const progress = Math.min((now - start) / 680, 1);
      setDisplay(Array.from(text).map((char, index, chars) =>
        /\s/.test(char) || index < progress * chars.length ? char : glyphs[(Math.floor((now - start) / 45) + index * 7) % glyphs.length]
      ).join(""));
      if (progress < 1) frame.current = requestAnimationFrame(tick);
    }
    frame.current = requestAnimationFrame(tick);
  }
  useEffect(() => {
    setDisplay(text);
    const observer = new IntersectionObserver((entries) => {
      if (entries.some(entry => entry.isIntersecting)) {
        observer.disconnect();
        play();
      }
    }, { threshold: 0.5 });
    if (heading.current) observer.observe(heading.current);
    return () => { observer.disconnect(); cancelAnimationFrame(frame.current); };
  }, [text]);
  return <Tag ref={heading} id={id} className="scramble-title" aria-label={text}>
    <span className="scramble-measure" aria-hidden="true">{text}</span>
    <span className="scramble-display" aria-hidden="true">{display}</span>
  </Tag>;
}

export function SmoothDisclosure({ summary, children, defaultOpen = false }: { summary: ReactNode; children: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => { body.current?.toggleAttribute("inert", !open); }, [open]);
  return <div className={`panel score-disclosure${open ? " is-open" : ""}`}>
    <button type="button" className="score-trigger" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
      <ChevronRight size={18} aria-hidden="true" /><span>{summary}</span>
    </button>
    <div id={id} className="score-collapse" aria-hidden={!open} ref={body}>
      <div className="score-collapse-inner"><div className="score-content">{children}</div></div>
    </div>
  </div>;
}

const stepNames = ["安装插件", "评分规则", "信任并试跑"];

export function StepCarousel({ children }: { children: ReactNode }) {
  const track = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(0);
  const count = Children.count(children);
  const id = useId();
  function go(index: number) {
    const container = track.current;
    const card = container?.children[index] as HTMLElement | undefined;
    if (container && card) container.scrollTo({ left: card.offsetLeft - container.offsetLeft, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
  }
  return <div className="setup-carousel" role="region" aria-roledescription="轮播" aria-label="Codex 配置步骤">
    <div className="setup-slider">
    <button type="button" className="button setup-arrow" aria-label="上一步" aria-controls={id} disabled={active === 0} onClick={() => go(active - 1)}><ArrowLeft size={18} /></button>
    <div id={id} className="setup-track" ref={track} tabIndex={0} aria-label="左右滑动查看步骤" onKeyDown={(event) => {
      if (event.target !== event.currentTarget) return;
      if (event.key === "ArrowRight" || event.key === "ArrowLeft") { event.preventDefault(); go(Math.max(0, Math.min(count - 1, active + (event.key === "ArrowRight" ? 1 : -1)))); }
    }} onScroll={() => {
      const container = track.current;
      if (!container) return;
      const distances = Array.from(container.children).map(child => Math.abs((child as HTMLElement).offsetLeft - container.offsetLeft - container.scrollLeft));
      setActive(distances.indexOf(Math.min(...distances)));
    }}>{children}</div>
    <button type="button" className="button setup-arrow" aria-label="下一步" aria-controls={id} disabled={active === count - 1} onClick={() => go(active + 1)}><ArrowRight size={18} /></button>
    </div>
    <div className="setup-dots">{stepNames.map((name, index) => <button type="button" key={name} aria-label={`第 ${index + 1} 步：${name}`} aria-current={active === index ? "step" : undefined} aria-controls={id} onClick={() => go(index)}><span aria-hidden="true" /></button>)}</div>
    <span className="setup-progress" aria-live="polite">步骤 {active + 1} / {count} · {stepNames[active]}</span>
  </div>;
}
