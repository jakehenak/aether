import { createFileRoute } from "@tanstack/react-router";
import { Theremin } from "@/components/theremin";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
  return <Theremin />;
}
