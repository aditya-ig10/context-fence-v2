import { useEffect, useRef } from 'react';
import { createTimeline } from 'animejs';

export default function LoadingScreen() {
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const loader = el.querySelector('.ls-loader') as HTMLElement;
    const fazers = el.querySelectorAll('.ls-fazers span');

    const tl = createTimeline({ loop: true });
    tl.add(loader, { scale: [1, 1.06, 1], duration: 800, easing: 'easeInOutSine' })
      .add(loader, { scale: [1, 0.96, 1], duration: 600, easing: 'easeInOutSine' }, 200);
    fazers.forEach((f, i) => {
      tl.add(f as HTMLElement, { opacity: [0.3, 1, 0.3], duration: 1200 + i * 200, easing: 'easeInOutSine' }, 0);
    });

    return () => { tl.pause(); };
  }, []);

  return (
    <div className="ls-root" ref={rootRef}>
      <div className="ls-loader">
        <span>
          <span /><span /><span /><span />
        </span>
        <div className="ls-base">
          <span />
          <div className="ls-face" />
        </div>
      </div>
      <div className="ls-fazers">
        <span /><span /><span /><span />
      </div>
      <style>{`
.ls-root {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100vh;
  width: 100vw;
  background: #faf9f6;
  position: relative;
  overflow: hidden;
  transition: background 400ms;
}
@media (prefers-color-scheme: dark) {
  .ls-root { background: #1a1c1a; }
}

.ls-loader {
  position: absolute;
  top: 50%;
  left: 50%;
  margin-left: -50px;
  animation: speeder 0.4s linear infinite;
  z-index: 2;
}
.ls-loader > span {
  height: 5px;
  width: 35px;
  background: #000;
  position: absolute;
  top: -19px;
  left: 60px;
  border-radius: 2px 10px 1px 0;
}
@media (prefers-color-scheme: dark) {
  .ls-loader > span { background: #e8e8e8; }
}
.ls-base span {
  position: absolute;
  width: 0;
  height: 0;
  border-top: 6px solid transparent;
  border-right: 100px solid #000;
  border-bottom: 6px solid transparent;
}
@media (prefers-color-scheme: dark) {
  .ls-base span { border-right-color: #e8e8e8; }
}
.ls-base span:before {
  content: "";
  height: 22px;
  width: 22px;
  border-radius: 50%;
  background: #000;
  position: absolute;
  right: -110px;
  top: -16px;
}
@media (prefers-color-scheme: dark) {
  .ls-base span:before { background: #e8e8e8; }
}
.ls-base span:after {
  content: "";
  position: absolute;
  width: 0;
  height: 0;
  border-top: 0 solid transparent;
  border-right: 55px solid #000;
  border-bottom: 16px solid transparent;
  top: -16px;
  right: -98px;
}
@media (prefers-color-scheme: dark) {
  .ls-base span:after { border-right-color: #e8e8e8; }
}
.ls-face {
  position: absolute;
  height: 12px;
  width: 20px;
  background: #000;
  border-radius: 20px 20px 0 0;
  transform: rotate(-40deg);
  right: -125px;
  top: -15px;
}
@media (prefers-color-scheme: dark) {
  .ls-face { background: #e8e8e8; }
}
.ls-face:after {
  content: "";
  height: 12px;
  width: 12px;
  background: #000;
  right: 4px;
  top: 7px;
  position: absolute;
  transform: rotate(40deg);
  transform-origin: 50% 50%;
  border-radius: 0 0 0 2px;
}
@media (prefers-color-scheme: dark) {
  .ls-face:after { background: #e8e8e8; }
}

.ls-loader > span > span:nth-child(1),
.ls-loader > span > span:nth-child(2),
.ls-loader > span > span:nth-child(3),
.ls-loader > span > span:nth-child(4) {
  width: 30px;
  height: 1px;
  background: #000;
  position: absolute;
  animation: fazer1 0.2s linear infinite;
}
@media (prefers-color-scheme: dark) {
  .ls-loader > span > span:nth-child(1),
  .ls-loader > span > span:nth-child(2),
  .ls-loader > span > span:nth-child(3),
  .ls-loader > span > span:nth-child(4) { background: #e8e8e8; }
}
.ls-loader > span > span:nth-child(2) { top: 3px; animation: fazer2 0.4s linear infinite; }
.ls-loader > span > span:nth-child(3) { top: 1px; animation: fazer3 0.4s linear infinite; animation-delay: -1s; }
.ls-loader > span > span:nth-child(4) { top: 4px; animation: fazer4 1s linear infinite; animation-delay: -1s; }

@keyframes fazer1 {
  0% { left: 0; }
  100% { left: -80px; opacity: 0; }
}
@keyframes fazer2 {
  0% { left: 0; }
  100% { left: -100px; opacity: 0; }
}
@keyframes fazer3 {
  0% { left: 0; }
  100% { left: -50px; opacity: 0; }
}
@keyframes fazer4 {
  0% { left: 0; }
  100% { left: -150px; opacity: 0; }
}

@keyframes speeder {
  0%   { transform: translate(2px, 1px) rotate(0deg); }
  10%  { transform: translate(-1px, -3px) rotate(-1deg); }
  20%  { transform: translate(-2px, 0px) rotate(1deg); }
  30%  { transform: translate(1px, 2px) rotate(0deg); }
  40%  { transform: translate(1px, -1px) rotate(1deg); }
  50%  { transform: translate(-1px, 3px) rotate(-1deg); }
  60%  { transform: translate(-1px, 1px) rotate(0deg); }
  70%  { transform: translate(3px, 1px) rotate(-1deg); }
  80%  { transform: translate(-2px, -1px) rotate(1deg); }
  90%  { transform: translate(2px, 1px) rotate(0deg); }
  100% { transform: translate(1px, -2px) rotate(-1deg); }
}

.ls-fazers {
  position: absolute;
  width: 100%;
  height: 100%;
  z-index: 1;
}
.ls-fazers span {
  position: absolute;
  height: 2px;
  width: 20%;
  background: #000;
}
@media (prefers-color-scheme: dark) {
  .ls-fazers span { background: #e8e8e8; }
}
.ls-fazers span:nth-child(1) { top: 20%; animation: lf 0.6s linear infinite; animation-delay: -5s; }
.ls-fazers span:nth-child(2) { top: 40%; animation: lf2 0.8s linear infinite; animation-delay: -1s; }
.ls-fazers span:nth-child(3) { top: 60%; animation: lf3 0.6s linear infinite; }
.ls-fazers span:nth-child(4) { top: 80%; animation: lf4 0.5s linear infinite; animation-delay: -3s; }

@keyframes lf {
  0%   { left: 200%; }
  100% { left: -200%; opacity: 0; }
}
@keyframes lf2 {
  0%   { left: 200%; }
  100% { left: -200%; opacity: 0; }
}
@keyframes lf3 {
  0%   { left: 200%; }
  100% { left: -100%; opacity: 0; }
}
@keyframes lf4 {
  0%   { left: 200%; }
  100% { left: -100%; opacity: 0; }
}
      `}</style>
    </div>
  );
}
