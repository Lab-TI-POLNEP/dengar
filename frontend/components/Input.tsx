import { forwardRef } from "react";
import type { InputHTMLAttributes } from "react";

type InputProps = InputHTMLAttributes<HTMLInputElement> & {
  variant?: "default" | "code";
  inputSize?: "sm" | "md" | "lg";
};

const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { variant = "default", inputSize = "md", className = "", ...props },
  ref
) {
  const cls = [
    "input",
    variant !== "default" && `input--${variant}`,
    inputSize !== "md" && `input--${inputSize}`,
    className,
  ]
    .filter(Boolean)
    .join(" ")
    .trim();

  return <input ref={ref} className={cls} {...props} />;
});

export default Input;

