/// <reference types="vite/client" />

interface Window {
	__DECISION_THEATRE_WEBVIEW__?: boolean;
}

interface ImportMetaEnv {
	readonly VITE_FEEDBACK_FORM_URL?: string;
}
