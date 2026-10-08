import { PondDemo } from "./pond-demo";

export default function Home() {
  return (
    <main className="relative h-dvh w-full overflow-hidden bg-[#0f2a1c]">
      <PondDemo />
      <p className="pointer-events-none absolute bottom-4 left-1/2 -translate-x-1/2 text-sm text-white/70">
        tap the water
      </p>
    </main>
  );
}
