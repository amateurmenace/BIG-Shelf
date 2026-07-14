import type { ActionFunctionArgs } from "react-router";
import { data } from "react-router";
import { z } from "zod";
import { sendOTP } from "~/modules/auth/service.server";
import { assertActiveNeonMemberForOtp } from "~/modules/big-neon-auth/service.server";
import { makeShelfError, notAllowedMethod } from "~/utils/error";

import {
  payload,
  error,
  getActionMethod,
  parseData,
} from "~/utils/http.server";
import { validEmail } from "~/utils/misc";

export async function action({ request }: ActionFunctionArgs) {
  try {
    const method = getActionMethod(request);

    switch (method) {
      case "POST": {
        const { email } = parseData(
          await request.formData(),
          z.object({
            email: z
              .string()
              .transform((email) => email.toLowerCase())
              .refine(validEmail, () => ({
                message: "Please enter a valid email",
              })),
          }),
          { shouldBeCaptured: false }
        );

        // BIG: this endpoint took any email and mailed a code, with no gate at
        // all — and the code it mails is enough to MINT an account at /otp. Gate
        // it exactly like /send-otp, or closing that hole just moves it here.
        await assertActiveNeonMemberForOtp(email);

        await sendOTP(email);
        return payload({ success: true });
      }
    }

    throw notAllowedMethod(method);
  } catch (cause) {
    //@ts-expect-error
    const isRateLimitError = cause.code === "over_email_send_rate_limit";

    const reason = makeShelfError(cause, {}, !isRateLimitError);
    return data(error(reason), { status: reason.status });
  }
}
