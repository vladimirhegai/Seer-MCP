// React + JSX fixture for Strata smoke tests.
// Critically this file contains JSX, which the plain `typescript` grammar
// cannot parse — it must be routed to the `tsx` grammar.

import React, { useState } from 'react';

interface CounterProps {
  initial: number;
  label?: string;
}

function formatLabel(label: string | undefined, value: number): string {
  return label ? `${label}: ${value}` : String(value);
}

export function Counter({ initial, label }: CounterProps) {
  const [count, setCount] = useState(initial);

  const handleIncrement = () => {
    setCount(count + 1);
  };

  return (
    <div className="counter">
      <span>{formatLabel(label, count)}</span>
      <button onClick={handleIncrement}>+</button>
    </div>
  );
}

export function Dashboard() {
  return (
    <main>
      <Counter initial={0} label="Apples" />
      <Counter initial={5} label="Oranges" />
    </main>
  );
}
