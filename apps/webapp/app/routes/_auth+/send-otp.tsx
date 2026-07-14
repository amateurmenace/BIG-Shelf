import type { ActionFunctionArgs } from "react-router";
import { data, redirect } from "react-router";

import { SendOtpSchema } from "~/modules/auth/components/continue-with-email-form";
import { sendOTP } from "~/modules/auth/service.server";
import { assertActiveNeonMemberForOtp } from "~/modules/big-neon-auth/service.server";
import { findUserByEmail } from "~/modules/user/service.server";
import { makeShelfError, notAllowedMethod } from "~/utils/error";
import { error, getActionMethod, parseData } from "~/utils/http.server";
import { validateNonSSOSignup } from "~/utils/sso.server";

export async function action({ request }: ActionFunctionArgs) {
  try {
    const method = getActionMethod(request);

    switch (method) {
      case "POST": {
        const { email, mode } = parseData(
          await request.formData(),
          SendOtpSchema,
          { shouldBeCaptured: false }
        );

        // `mode` is posted by the form, so it cannot decide whether this is a
        // signup: an OTP for an email with no account CREATES one, whatever the
        // client called it. Ask the database instead — otherwise /login's
        // "Continue with OTP" button is a way around both gates below.
        const isNewAccount = !(await findUserByEmail(email));

        if (mode === "signup" || mode === "confirm_signup" || isNewAccount) {
          await validateNonSSOSignup(email);
        }

        // BIG: creating an account requires an active Neon membership. Decided
        // server-side from the DB, so it holds regardless of the posted `mode`.
        await assertActiveNeonMemberForOtp(email);

        await sendOTP(email);

        return redirect(`/otp?email=${encodeURIComponent(email)}&mode=${mode}`);
      }
    }

    throw notAllowedMethod(method);
  } catch (cause) {
    const reason = makeShelfError(cause);
    return data(error(reason), { status: reason.status });
  }
}
