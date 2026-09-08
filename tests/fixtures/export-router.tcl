# Read the selected experimental builders; no runner or model request is invoked.
set experiment [file normalize [lindex $argv 0]]
source [file join $experiment followup.tcl]
set prompts [::routerlabel::loadJson [file join $experiment followup-prompts.json]]
puts [::json::write object \
  prompt [::routerlabel::jsonString [::routerfollowup::promptText $experiment $prompts p4 flat_schema]] \
  response_format [::routerfollowup::responseFormat]]
