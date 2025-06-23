# XSD Treeview Extension for Visual Studio Code
This VSCode extension provide a XML-schema tree view for elements.

![Treeview screenshot](/images/screenshot_0.png)

## Features

- Provide Treeview in Explorer tab for elements in XML-schema (files with XML extension and namespace "http://www.w3.org/2001/XMLSchema")
- Auto update view when document updates
- Support extension, choice, enum types
- Support local imports
- Highlight nilable values
- Display minOccurs and maxOccurs attributes
- Documentation in tooltips
- Different icons for different types
- Also show type in description of the tree element

## Attributes

- Nilable values has subdued font color
- If an element has minOccurs or maxOccurs - this is displayed on the right side of the tree element:
	- 1 for defaults
	- N for specific values
	- ∞ for unbounded
- Information about the attributes above is duplicated in the tooltip