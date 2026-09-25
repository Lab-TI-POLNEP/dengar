import type { ReactNode } from "react";

type FormFieldProps = {
  label: string;
  id: string;
  hint?: string;
  children: ReactNode;
};

export default function FormField({
  label,
  id,
  hint,
  children,
}: FormFieldProps) {
  return (
    <label htmlFor={id} className="admin-form__field">
      <span>{label}</span>
      {children}
      {hint ? <span className="admin-form__hint">{hint}</span> : null}
    </label>
  );
}
