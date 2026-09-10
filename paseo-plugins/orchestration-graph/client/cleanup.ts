const stops: Array<() => void> = [];

export function registerStop(stop: () => void): () => void {
  stops.push(stop);
  return () => {
    stop();
    const index = stops.indexOf(stop);
    if (index >= 0) {
      stops.splice(index, 1);
    }
  };
}

export function stopAll(): void {
  while (stops.length > 0) {
    const stop = stops.pop();
    if (stop) {
      stop();
    }
  }
}
