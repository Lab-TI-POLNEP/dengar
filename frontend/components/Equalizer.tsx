type EqualizerProps = {
  bars?: number;
  className?: string;
};

export default function Equalizer({ bars = 28, className = "" }: EqualizerProps) {
  return (
    <div className={`equalizer ${className}`.trim()} aria-hidden="true">
      {Array.from({ length: bars }, (_, index) => (
        <span
          key={index}
          style={{
            animationDelay: `${(index % 9) * 90}ms`,
            animationDuration: `${950 + (index % 5) * 120}ms`,
          }}
        />
      ))}
    </div>
  );
}
