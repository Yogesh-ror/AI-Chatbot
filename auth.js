const form = document.querySelector("#auth-form");
const nameField = document.querySelector("#name-field");
const nameInput = document.querySelector("#name-input");
const emailInput = document.querySelector("#email-input");
const passwordInput = document.querySelector("#password-input");
const confirmField = document.querySelector("#confirm-field");
const confirmPasswordInput = document.querySelector("#confirm-password-input");
const errorBox = document.querySelector("#auth-error");
const submitButton = document.querySelector("#auth-submit");
const submitLabel = document.querySelector("#submit-label");
const switchMode = document.querySelector("#switch-mode");
const switchPrompt = document.querySelector("#switch-prompt");
const tabs = { login: document.querySelector("#login-tab"), signup: document.querySelector("#signup-tab") };
let mode = "login";

function explainNetworkError(error) {
  if (error instanceof TypeError || /failed to fetch|networkerror/i.test(error?.message || "")) {
    return "Aster cannot reach its local server. Start the app with npm start from the app folder, then reload this page.";
  }
  return error?.message || "We couldn’t complete that request.";
}

function setMode(nextMode) {
  mode = nextMode;
  const signup = mode === "signup";
  nameField.hidden = !signup;
  nameInput.required = signup;
  confirmField.hidden = !signup;
  confirmPasswordInput.required = signup;
  passwordInput.autocomplete = signup ? "new-password" : "current-password";
  document.querySelector("#password-hint").hidden = !signup;
  document.querySelector("#auth-kicker").textContent = signup ? "MAKE YOURSELF AT HOME" : "WELCOME BACK";
  document.querySelector("#auth-title").textContent = signup ? "Create your account" : "Sign in to Aster";
  document.querySelector("#auth-subtitle").textContent = signup ? "A little space for all your questions." : "Your next good question is waiting.";
  submitLabel.textContent = signup ? "Create account" : "Log in";
  switchPrompt.textContent = signup ? "Already have an account?" : "New to Aster?";
  switchMode.textContent = signup ? "Log in" : "Create an account";
  tabs.login.classList.toggle("active", !signup);
  tabs.signup.classList.toggle("active", signup);
  tabs.login.setAttribute("aria-selected", String(!signup));
  tabs.signup.setAttribute("aria-selected", String(signup));
  errorBox.hidden = true;
  errorBox.textContent = "";
}

async function checkExistingSession() {
  try {
    const response = await fetch("/api/auth/me", { cache: "no-store" });
    if (response.ok) window.location.replace("/");
  } catch {
    showError("Aster cannot reach its local server. Start the app with npm start from the app folder, then reload this page.");
  }
}

function showError(message) {
  errorBox.textContent = message;
  errorBox.hidden = false;
}

tabs.login.addEventListener("click", () => setMode("login"));
tabs.signup.addEventListener("click", () => setMode("signup"));
switchMode.addEventListener("click", () => setMode(mode === "login" ? "signup" : "login"));

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  errorBox.hidden = true;
  const name = nameInput.value.trim();
  const email = emailInput.value.trim();
  const password = passwordInput.value;
  const confirmPassword = confirmPasswordInput.value;
  if (mode === "signup" && name.length < 1) { showError("Add your name to create an account."); nameInput.focus(); return; }
  if (!emailInput.validity.valid) { showError("Enter a valid email address."); emailInput.focus(); return; }
  if (password.length < 10) { showError("Your password needs at least 10 characters."); passwordInput.focus(); return; }
  if (mode === "signup" && password !== confirmPassword) { showError("Those passwords don’t match."); confirmPasswordInput.focus(); return; }

  submitButton.disabled = true;
  submitButton.classList.add("loading");
  submitLabel.textContent = mode === "signup" ? "Creating your account…" : "Signing you in…";
  try {
    const response = await fetch(`/api/auth/${mode}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, email, password }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || "We couldn’t complete that request.");
    window.location.replace("/");
  } catch (error) {
    showError(explainNetworkError(error));
    submitButton.disabled = false;
    submitButton.classList.remove("loading");
    submitLabel.textContent = mode === "signup" ? "Create account" : "Log in";
  }
});

checkExistingSession();
