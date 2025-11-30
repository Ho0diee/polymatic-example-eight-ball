import React, { useState } from "react";

interface EmailLoginProps {
  onLogin: (email: string, password: string) => void;
  error?: string;
}

export const EmailLogin: React.FC<EmailLoginProps> = ({ onLogin, error }) => {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onLogin(email, password);
  };

  return (
    <div className="email-login-container">
      <form onSubmit={handleSubmit} className="email-login-form">
        <h2>Login</h2>
        <label>
          Email:
          <input
            type="email"
            value={email}
            onChange={e => setEmail(e.target.value)}
            required
            autoFocus
          />
        </label>
        <label>
          Password:
          <input
            type="password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            required
          />
        </label>
        {error && <div className="error-message">{error}</div>}
        <button type="submit">Log In</button>
      </form>
    </div>
  );
};
