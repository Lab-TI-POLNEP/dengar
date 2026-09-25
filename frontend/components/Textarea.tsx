import { forwardRef } from "react";
import type { TextareaHTMLAttributes } from "react";

type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement> & {
  variant?: "default" | "mono";
};

const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  function Textarea({ variant = "default", className = "", ...props }, ref) {
    const cls = [
      "textarea",
      variant !== "default" && `textarea--${variant}`,
      className,
    ]
      .filter(Boolean)
      .join(" ")
      .trim();

    return <textarea ref={ref} className={cls} {...props} />;
  }
);

export default Textarea;

