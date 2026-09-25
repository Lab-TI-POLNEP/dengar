import type { ReactNode } from "react";

type CardProps = {
  title: string;
  children: ReactNode;
  className?: string;
};

export default function Card({ title, children, className = "" }: CardProps) {
  return (
    <section className={`card ${className}`.trim()}>
      <h2 className="card__title">{title}</h2>
      <div className="card__text">{children}</div>
    </section>
  );
}
