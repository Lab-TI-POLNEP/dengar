import { forwardRef } from "react";
import type { InputHTMLAttributes } from "react";

type CheckboxProps = Omit<InputHTMLAttributes<HTMLInputElement>, "type"> & {
  label?: string;
};

const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox(
  { label, className = "", id, ...props },
  ref
) {
  if (!label) {
    return (
      <input
        ref={ref}
        type="checkbox"
        id={id}
        className={`checkbox__input ${className}`.trim()}
        {...props}
      />
    );
  }

  return (
    <label className={`checkbox ${className}`.trim()} htmlFor={id}>
      <input
        ref={ref}
        type="checkbox"
        id={id}
        className="checkbox__input"
        {...props}
      />
      <span className="checkbox__label">{label}</span>
    </label>
  );
});

export default Checkbox;

