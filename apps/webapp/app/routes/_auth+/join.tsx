import type {
  LoaderFunctionArgs,
  ActionFunctionArgs,
  MetaFunction,
} from "react-router";
import {
  redirect,
  data,
  useActionData,
  useLoaderData,
  useNavigation,
} from "react-router";

import { useZorm } from "react-zorm";
import { z } from "zod";
import { SocialLoginButtons } from "~/components/big/social-login-buttons";
import { Form } from "~/components/custom-form";

import Input from "~/components/forms/input";
import PasswordInput from "~/components/forms/password-input";
import { Button } from "~/components/shared/button";
import { config } from "~/config/shelf.config";
import { useSearchParams } from "~/hooks/search-params";
import { useAutoFocus } from "~/hooks/use-auto-focus";
import { signUpWithEmailPass } from "~/modules/auth/service.server";
import { assertActiveNeonMemberForSignup } from "~/modules/big-neon-auth/service.server";
import { findUserByEmail } from "~/modules/user/service.server";
import { appendToMetaTitle } from "~/utils/append-to-meta-title";
import { ENABLE_GOOGLE_LOGIN, ENABLE_MICROSOFT_LOGIN } from "~/utils/env";
import {
  ShelfError,
  isZodValidationError,
  makeShelfError,
  notAllowedMethod,
} from "~/utils/error";
import { isFormProcessing } from "~/utils/form";
import {
  payload,
  error,
  getActionMethod,
  parseData,
} from "~/utils/http.server";
import { validEmail } from "~/utils/misc";
import { validateNonSSOSignup } from "~/utils/sso.server";

export function loader({ context }: LoaderFunctionArgs) {
  const title = "Create an account";
  const subHeading = "Start your journey with BIG Shelf";
  const { disableSignup } = config;

  try {
    if (disableSignup) {
      throw new ShelfError({
        cause: null,
        title: "Signup is disabled",
        message:
          "For more information, please contact your workspace administrator.",
        label: "User onboarding",
        status: 403,
        shouldBeCaptured: false,
      });
    }
    if (context.isAuthenticated) {
      // BIG: default landing is the home dashboard
      return redirect("/home");
    }

    return data(
      payload({
        title,
        subHeading,
        googleLoginEnabled: ENABLE_GOOGLE_LOGIN,
        microsoftLoginEnabled: ENABLE_MICROSOFT_LOGIN,
      })
    );
  } catch (cause) {
    const reason = makeShelfError(cause);
    throw data(error(reason), { status: reason.status });
  }
}

const JoinFormSchema = z
  .object({
    email: z
      .string()
      .transform((email) => email.toLowerCase())
      .refine(validEmail, () => ({
        message: "Please enter a valid email",
      })),
    password: z
      .string()
      .min(8, "Your password is too short. Min 8 characters are required."),
    confirmPassword: z
      .string()
      .min(8, "Your password is too short. Min 8 characters are required."),
    redirectTo: z.string().optional(),
  })
  .superRefine(({ password, confirmPassword }, ctx) => {
    if (password !== confirmPassword) {
      return ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Password and confirm password must match",
        path: ["confirmPassword"],
      });
    }
  });

export async function action({ request }: ActionFunctionArgs) {
  try {
    const method = getActionMethod(request);

    switch (getActionMethod(request)) {
      case "POST": {
        const { email, password } = parseData(
          await request.formData(),
          JoinFormSchema,
          { shouldBeCaptured: false }
        );
        // Block signup if domain uses SSO
        await validateNonSSOSignup(email);
        // BIG: self-signup requires an active Neon membership.
        await assertActiveNeonMemberForSignup(email);

        const existingUser = await findUserByEmail(email);

        if (existingUser) {
          throw new ShelfError({
            cause: null,
            message: "User with this Email already exits, login instead",
            additionalData: {
              email,
            },
            label: "User onboarding",
            shouldBeCaptured: false,
            status: 409,
          });
        }

        // Sign up with the provided email and password
        await signUpWithEmailPass(email, password);

        return redirect(
          `/otp?email=${encodeURIComponent(email)}&mode=confirm_signup`
        );
      }
    }

    throw notAllowedMethod(method);
  } catch (cause) {
    const reason = makeShelfError(
      cause,
      undefined,
      isZodValidationError(cause)
    );
    return data(error(reason), { status: reason.status });
  }
}

export const meta: MetaFunction<typeof loader> = ({ data }) => [
  { title: data ? appendToMetaTitle(data.title) : "" },
];

export default function Join() {
  const zo = useZorm("NewQuestionWizardScreen", JoinFormSchema);
  const [searchParams] = useSearchParams();
  const redirectTo = searchParams.get("redirectTo") ?? undefined;
  const navigation = useNavigation();
  const disabled = isFormProcessing(navigation.state);
  const data = useActionData<typeof action>();
  const { googleLoginEnabled, microsoftLoginEnabled } =
    useLoaderData<typeof loader>();

  /** Focus the email field on mount (intentional first-field focus on auth pages). */
  const emailInputRef = useAutoFocus<HTMLInputElement>();

  /** Whether social sign-up (Google / Microsoft) is available. */
  const hasSocial = googleLoginEnabled || microsoftLoginEnabled;

  return (
    <div className="flex min-h-full flex-col justify-center">
      <div className="mx-auto w-full max-w-md">
        {/* Primary: sign up with a provider */}
        {hasSocial ? (
          <SocialLoginButtons
            google={googleLoginEnabled}
            microsoft={microsoftLoginEnabled}
          />
        ) : null}

        {hasSocial ? (
          <div className="my-6 flex items-center gap-3">
            <span className="h-px flex-1 bg-gray-200" />
            <span className="text-xs font-medium uppercase tracking-wide text-gray-400">
              or with email
            </span>
            <span className="h-px flex-1 bg-gray-200" />
          </div>
        ) : null}

        {/* Secondary: email + password */}
        <Form
          ref={zo.ref}
          method="post"
          className="flex flex-col gap-3"
          replace
        >
          <Input
            ref={emailInputRef}
            data-test-id="email"
            label="Email"
            placeholder="you@brooklineinteractive.org"
            required
            name={zo.fields.email()}
            type="email"
            autoComplete="email"
            disabled={disabled}
            inputClassName="w-full"
            error={zo.errors.email()?.message || data?.error.message}
          />
          <PasswordInput
            label="Password"
            placeholder="**********"
            required
            data-test-id="password"
            name={zo.fields.password()}
            autoComplete="new-password"
            disabled={disabled}
            inputClassName="w-full"
            error={zo.errors.password()?.message}
          />
          <PasswordInput
            label="Confirm password"
            placeholder="**********"
            required
            data-test-id="confirmPassword"
            name={zo.fields.confirmPassword()}
            autoComplete="new-password"
            disabled={disabled}
            inputClassName="w-full"
            error={zo.errors.confirmPassword()?.message}
          />
          <input
            type="hidden"
            name={zo.fields.redirectTo()}
            value={redirectTo}
          />
          <Button
            type="submit"
            data-test-id="login"
            width="full"
            disabled={disabled}
          >
            Create account
          </Button>
        </Form>

        {/* Log in — a prominent action, not a buried link */}
        <div className="mt-8 rounded-lg border border-gray-200 bg-gray-50 p-4 text-center">
          <p className="mb-3 text-sm text-gray-600">Already have an account?</p>
          <Button
            variant="secondary"
            width="full"
            to={{ pathname: "/", search: searchParams.toString() }}
          >
            Log in
          </Button>
        </div>
      </div>
    </div>
  );
}
