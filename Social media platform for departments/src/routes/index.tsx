import { createFileRoute } from "@tanstack/react-router";
import { useEffect } from "react";

export const Route = createFileRoute("/")({
  component: PrototypeRedirect,
});

function PrototypeRedirect() {
  useEffect(() => {
    window.location.replace("/prototype/index.html");
  }, []);

  return <p>Opening the project...</p>;
}
