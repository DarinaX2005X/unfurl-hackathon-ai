"use client";

import { Eye, EyeOff } from "lucide-react";
import { useState } from "react";
import { IconButton, TextField, type TextFieldProps } from "@/components/ui";

export function PasswordField(props: Omit<TextFieldProps, "type">) {
  const [visible, setVisible] = useState(false);
  return <div className="uf-account-password">
    <TextField {...props} type={visible ? "text" : "password"} className="uf-account-password__field" />
    <IconButton className="uf-account-password__toggle" label={`${visible ? "Hide" : "Show"} ${props.label.toLowerCase()}`}
      icon={visible ? <EyeOff size={20} strokeWidth={1.75} /> : <Eye size={20} strokeWidth={1.75} />}
      aria-pressed={visible} onClick={() => setVisible((value) => !value)} />
  </div>;
}
