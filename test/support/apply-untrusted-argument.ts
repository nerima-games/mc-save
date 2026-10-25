export const applyUntrustedArgument = <This, Args extends ReadonlyArray<unknown>, A>(
  method: (this: This, ...args: Args) => A,
  receiver: This,
  argumentsList: ReadonlyArray<unknown>,
): A => Reflect.apply(method, receiver, argumentsList)
