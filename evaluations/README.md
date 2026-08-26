# Evaluations

`eurodns.xml` holds ten read-only questions used to check that a model can actually get work
done through this server.

**The answers are not filled in.** Every question resolves against a live EuroDNS account,
and the correct answer depends on which domains, subscriptions and invoices that account
holds. Filling them in from anything other than a real run would make the suite look like it
passes while testing nothing.

To complete the suite, run each question against an account with credentials configured,
confirm the answer by hand, and replace the `TO-BE-VERIFIED` placeholder with the exact
string a correct run produces. Keep to answers that will not drift: a TLD's terms are stable,
a domain's expiry date is not.

Every question is read-only, independent of the others, and answerable without any operation
that changes state.
