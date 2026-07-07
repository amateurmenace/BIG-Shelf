import type { LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";
import { appendToMetaTitle } from "~/utils/append-to-meta-title";

export const meta = () => [{ title: appendToMetaTitle("Home") }];

export const loader = ({ context }: LoaderFunctionArgs) => {
  if (context.isAuthenticated) {
    // BIG: default landing is the home dashboard
    return redirect("/home");
  }

  return redirect("/login");
};

export default function Route() {
  return null;
}
