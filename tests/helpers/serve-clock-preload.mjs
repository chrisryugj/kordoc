if (process.argv[2] === "serve") {
  const realNow = Date.now
  let offset = 0
  Date.now = () => realNow() + offset
  process.on("message", milliseconds => {
    offset += milliseconds
    process.send("clock-advanced")
  })
}
