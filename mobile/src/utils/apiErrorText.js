// The backend answers an unexpected server failure with {"error":"internal_error"}, and apiClient turns the error
// code into error.message, which several screens show to the user as-is. This turns that one code into a
// sentence; every other code is returned unchanged (an unknown code still falls back to the caller's text), and
// error.payload.error keeps the original code for the places that branch on it.
export function describeApiError(code) {
  return code === "internal_error" ? "伺服器發生錯誤，請稍後再試。" : code;
}
