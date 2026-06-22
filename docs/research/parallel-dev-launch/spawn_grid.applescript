on run argv
  tell application "iTerm2"
    activate
    set w to (create window with default profile)
    set ss to {current session of w}
    set n to (count of argv)
    repeat with i from 2 to n
      set prev to item (i - 1) of ss
      tell prev
        set newS to (split vertically with same profile)
      end tell
      set end of ss to newS
    end repeat
    repeat with i from 1 to n
      tell item i of ss
        write text (item i of argv)
      end tell
    end repeat
  end tell
end run
