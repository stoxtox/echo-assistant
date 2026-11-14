// Runs the app's "stop Echo's server" step (Server.swift finishStopping) against a port and an
// Echo folder, for test/lifecycle.test.js: it starts throwaway servers and checks that one running
// from that folder is stopped and one running from another folder is left alone.
// Compiled with macos/Sources/Server.swift and PointMath.swift.
//
//   quit-check PORT ECHO_FOLDER
//   quit-check --starting PORT ECHO_FOLDER   Quit while the folder's scripts/launcher.sh is still
//                                            starting the server: the launcher is stopped first.
import Foundation

var args = Array(CommandLine.arguments.dropFirst())
let starting = args.first == "--starting"
if starting { args.removeFirst() }
guard args.count == 2, let port = Int(args[0]) else {
  print("usage: quit-check [--starting] PORT ECHO_FOLDER")
  exit(2)
}
let server = EchoServer(port: port, echoDir: URL(fileURLWithPath: args[1]))
let quit = {
  server.stopStarting {
    server.finishStopping {
      print("done")
      exit(0)
    }
  }
}
if starting {
  server.start { _ in }
  DispatchQueue.main.asyncAfter(deadline: .now() + 0.6, execute: quit)
} else {
  quit()
}
dispatchMain()
