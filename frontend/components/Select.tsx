import { forwardRef } from "react";
import type { SelectHTMLAttributes } from "react";

type SelectProps = SelectHTMLAttributes<HTMLSelectElement>;

const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { className = "", ...props },
  ref
) {
  return (
    <select
      ref={ref}
      className={`select ${className}`.trim()}
      {...props}
    />
  );
});

export default Select;

