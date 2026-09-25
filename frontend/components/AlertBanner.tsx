type AlertBannerProps = {
  title: string;
  description: string;
  className?: string;
};

export default function AlertBanner({ title, description, className = "" }: AlertBannerProps) {
  return (
    <div className={`alert-banner ${className}`.trim()} role="status" aria-live="polite">
      <strong>{title}</strong>
      <p>{description}</p>
    </div>
  );
}
